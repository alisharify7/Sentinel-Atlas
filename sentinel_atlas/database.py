"""Persistent accounts, revocable sessions, and login throttling."""
import hashlib
import re
import secrets
import time
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, create_engine, delete, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool
from werkzeug.security import check_password_hash, generate_password_hash


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = 'users'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True)
    password_hash: Mapped[str] = mapped_column(String(512))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


class LoginSession(Base):
    __tablename__ = 'login_sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    expires_at: Mapped[float] = mapped_column(Float, index=True)


class LoginThrottle(Base):
    __tablename__ = 'login_throttles'
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[float] = mapped_column(Float)


class UserProfile(Base):
    __tablename__ = 'user_profiles'
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(100), default='')
    email: Mapped[str] = mapped_column(String(254), default='')
    organization: Mapped[str] = mapped_column(String(100), default='')
    timezone: Mapped[str] = mapped_column(String(64), default='UTC')
    bio: Mapped[str] = mapped_column(String(500), default='')


class ShareLink(Base):
    __tablename__ = 'share_links'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    label: Mapped[str] = mapped_column(String(100))
    cluster: Mapped[str] = mapped_column(String(1024))
    allow_config: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_logs: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_details: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_events: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    expires_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    revoked_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_used_at: Mapped[float | None] = mapped_column(Float, nullable=True)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def validate_account(username, password):
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', username):
        raise ValueError('Use 1–80 letters, numbers, dots, underscores, or hyphens for the account name.')
    if not 8 <= len(password) <= 256:
        raise ValueError('Passwords must contain 8–256 characters.')


def database_url(value):
    if value.startswith(('postgres://', 'postgresql://')):
        value = 'postgresql+psycopg://' + value.split('://', 1)[1]
    url = make_url(value)
    if url.drivername not in ('sqlite', 'sqlite+pysqlite', 'postgresql+psycopg'):
        raise ValueError('DATABASE_URL must use SQLite or PostgreSQL (psycopg).')
    return url


class AccountStore:
    def __init__(self, url):
        url = database_url(url)
        options = {'pool_pre_ping': True, 'hide_parameters': True}
        if url.get_backend_name() == 'sqlite':
            options['connect_args'] = {'check_same_thread': False, 'timeout': 15}
            if not url.database or url.database == ':memory:':
                options['poolclass'] = StaticPool
            else:
                Path(url.database).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(url, **options)
        try:
            Base.metadata.create_all(self.engine)
        except Exception:
            self.engine.dispose()
            raise
        self.session = sessionmaker(self.engine, expire_on_commit=False)
        # Equal-cost password checks for unknown accounts.
        self.dummy_hash = generate_password_hash(secrets.token_urlsafe(32), method='scrypt')

    def bootstrap(self, username, password):
        with self.session.begin() as db:
            if db.scalar(select(User.id).limit(1)) is not None:
                return
            if not password:
                raise ValueError('Set DEFAULT_PASSWORD (at least 8 characters) before the first start.')
            validate_account(username, password)
            db.add(User(username=username, password_hash=generate_password_hash(password, method='scrypt'), is_admin=True))

    def authenticate(self, username, password, address):
        now = time.time()
        # IP-wide bucket also limits attempts against invented user names.
        key = digest(address)
        with self.session.begin() as db:
            db.execute(delete(LoginThrottle).where(LoginThrottle.expires_at < now))
            throttle = db.get(LoginThrottle, key)
            if throttle and throttle.attempts >= 5:
                return None, True
            user = db.scalar(select(User).where(User.username == username))
            valid = check_password_hash(user.password_hash if user else self.dummy_hash, password)
            if valid and user and user.active:
                if throttle:
                    db.delete(throttle)
                return user, False
            if throttle:
                db.execute(update(LoginThrottle).where(LoginThrottle.key == key).values(attempts=LoginThrottle.attempts + 1))
            else:
                db.add(LoginThrottle(key=key, attempts=1, expires_at=now + 300))
            return None, False

    def issue_session(self, user_id, seconds):
        token = secrets.token_urlsafe(48)
        with self.session.begin() as db:
            db.execute(delete(LoginSession).where(LoginSession.expires_at <= time.time()))
            db.add(LoginSession(token_hash=digest(token), user_id=user_id, expires_at=time.time() + seconds))
        return token

    def session_user(self, token):
        if not isinstance(token, str):
            return None
        with self.session() as db:
            return db.scalar(select(User).join(LoginSession).where(
                LoginSession.token_hash == digest(token), LoginSession.expires_at > time.time(), User.active.is_(True)))

    def logout(self, token):
        with self.session.begin() as db:
            db.execute(delete(LoginSession).where(LoginSession.token_hash == digest(token)))

    def list_users(self):
        with self.session() as db:
            return list(db.scalars(select(User).order_by(User.username)))

    def create_user(self, username, password, admin=False):
        validate_account(username, password)
        with self.session.begin() as db:
            if db.scalar(select(User.id).where(User.username == username)) is not None:
                raise ValueError('That account already exists.')
            db.add(User(username=username, password_hash=generate_password_hash(password, method='scrypt'), is_admin=admin))

    def change_password(self, user_id, password, current=None):
        validate_account('valid', password)
        with self.session.begin() as db:
            user = db.get(User, user_id)
            if not user or (current is not None and not check_password_hash(user.password_hash, current)):
                raise ValueError('The current password is incorrect.')
            user.password_hash = generate_password_hash(password, method='scrypt')
            db.execute(delete(LoginSession).where(LoginSession.user_id == user_id))

    def toggle_user(self, user_id, actor_id):
        if user_id == actor_id:
            raise ValueError('You cannot disable your own account.')
        with self.session.begin() as db:
            user = db.get(User, user_id)
            if not user:
                raise ValueError('Account not found.')
            user.active = not user.active
            db.execute(delete(LoginSession).where(LoginSession.user_id == user_id))
            if not user.active:
                db.execute(update(ShareLink).where(ShareLink.owner_id == user_id, ShareLink.revoked_at.is_(None)).values(revoked_at=time.time()))

    def profile(self, user_id):
        with self.session() as db:
            return db.get(UserProfile, user_id) or UserProfile(user_id=user_id, display_name='', email='', organization='', timezone='UTC', bio='')

    def update_profile(self, user_id, username, values, current_password=''):
        validate_account(username, 'profile-validation')
        limits = {'display_name': 100, 'email': 254, 'organization': 100, 'timezone': 64, 'bio': 500}
        fields = {key: str(values.get(key, '')).strip() for key in limits}
        fields['timezone'] = fields['timezone'] or 'UTC'
        if any(len(fields[key]) > limit for key, limit in limits.items()):
            raise ValueError('A profile field exceeds its maximum length.')
        if fields['email'] and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', fields['email']):
            raise ValueError('Enter a valid email address.')
        try:
            ZoneInfo(fields['timezone'])
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('Enter a valid IANA timezone, such as UTC or Asia/Tehran.') from None
        with self.session.begin() as db:
            user = db.get(User, user_id)
            if username != user.username:
                if not check_password_hash(user.password_hash, current_password):
                    raise ValueError('Your current password is required to change your username.')
                if db.scalar(select(User.id).where(User.username == username, User.id != user_id)):
                    raise ValueError('That account name is already in use.')
                user.username = username
            profile = db.get(UserProfile, user_id)
            if not profile:
                profile = UserProfile(user_id=user_id)
                db.add(profile)
            for key, value in fields.items():
                setattr(profile, key, value)

    def active_sessions(self, user_id, current_token):
        with self.session() as db:
            return [{'current': row.token_hash == digest(current_token), 'expires_at': row.expires_at}
                    for row in db.scalars(select(LoginSession).where(LoginSession.user_id == user_id,
                        LoginSession.expires_at > time.time()).order_by(LoginSession.expires_at.desc()))]

    def revoke_other_sessions(self, user_id, current_token):
        with self.session.begin() as db:
            db.execute(delete(LoginSession).where(LoginSession.user_id == user_id,
                LoginSession.token_hash != digest(current_token)))
