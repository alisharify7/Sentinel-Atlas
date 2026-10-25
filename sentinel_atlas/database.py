"""Persistent accounts, revocable sessions, and login throttling."""
import hashlib
import re
import secrets
import time
from pathlib import Path

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
