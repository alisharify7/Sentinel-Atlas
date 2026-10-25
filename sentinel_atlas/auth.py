"""Required login, CSRF protection, and account administration."""
from datetime import timedelta
import hmac
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit

from flask import abort, flash, g, jsonify, redirect, render_template, request, session, url_for
from sqlalchemy.exc import SQLAlchemyError

from .database import AccountStore


def env_value(name, fallback=None):
    return os.getenv(name, os.getenv(name.lower(), fallback))


def persistent_key(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / 'session.key'
    try:
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            stream.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    return path.read_text().strip()


def safe_next(value):
    return value if value and value.startswith('/') and not value.startswith('//') and '\\' not in value and not urlsplit(value).netloc and not any(ord(c) < 32 for c in value) else '/'


def init_auth(app, overrides=None):
    app.config.from_mapping(
        DATABASE_URL=env_value('DATABASE_URL', 'sqlite:///' + str(Path(app.instance_path) / 'atlas.sqlite')),
        DEFAULT_ACCOUNT=env_value('DEFAULT_ACCOUNT', 'admin'),
        DEFAULT_PASSWORD=env_value('DEFAULT_PASSWORD'),
        SECRET_KEY=env_value('SECRET_KEY'),
        SESSION_COOKIE_NAME='sentinel_atlas', SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=env_value('SESSION_COOKIE_SECURE', 'false').lower() == 'true',
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8), SESSION_REFRESH_EACH_REQUEST=False,
        MAX_CONTENT_LENGTH=16384,
    )
    if overrides:
        app.config.update(overrides)
    app.secret_key = app.config['SECRET_KEY'] or persistent_key(Path(app.instance_path))
    if len(app.secret_key) < 32:
        raise ValueError('SECRET_KEY must contain at least 32 characters.')
    store = None
    try:
        store = AccountStore(app.config['DATABASE_URL'])
        store.bootstrap(app.config['DEFAULT_ACCOUNT'], app.config['DEFAULT_PASSWORD'])
    except (SQLAlchemyError, ValueError) as error:
        if store:
            store.engine.dispose()
        if isinstance(error, ValueError):
            raise
        raise ValueError('Cannot initialize the account database. Check DATABASE_URL and database access.') from None
    # Bootstrap credentials are not needed after creating the account.
    app.config['DEFAULT_PASSWORD'] = None
    app.extensions['accounts'] = store

    def csrf_token():
        if 'csrf' not in session:
            session['csrf'] = secrets.token_urlsafe(32)
        return session['csrf']

    app.jinja_env.globals['csrf_token'] = csrf_token

    @app.before_request
    def authenticate_request():
        if request.endpoint in ('static', 'health'):
            return
        g.user = store.session_user(session.get('auth_token'))
        if request.endpoint != 'login' and not g.user:
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Login required.', 'login_url': url_for('login')}), 401
            return redirect(url_for('login', next=request.full_path.rstrip('?')))
        if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            token = request.headers.get('X-CSRF-Token') or request.form.get('csrf_token', '')
            if not token or not hmac.compare_digest(token.encode(), session.get('csrf', '').encode()):
                return jsonify({'error': 'Invalid CSRF token. Reload the page and try again.'}), 400

    @app.route('/login', methods=['GET', 'POST'])
    def login():
        if g.user:
            return redirect(url_for('index'))
        error = None
        status = 200
        if request.method == 'POST':
            username = request.form.get('username', '').strip()
            password = request.form.get('password', '')
            user, limited = store.authenticate(username[:80], password[:257], request.remote_addr or 'unknown')
            if user:
                session.clear()
                session.permanent = True
                session['auth_token'] = store.issue_session(user.id, app.permanent_session_lifetime.total_seconds())
                csrf_token()
                return redirect(safe_next(request.args.get('next')))
            error = 'Too many attempts. Try again in five minutes.' if limited else 'Incorrect account name or password.'
            status = 429 if limited else 401
        return render_template('login.html', error=error), status

    @app.post('/logout')
    def logout():
        store.logout(session['auth_token'])
        session.clear()
        return redirect(url_for('login'))

    @app.route('/account', methods=['GET', 'POST'])
    def account():
        if request.method == 'POST':
            try:
                store.change_password(g.user.id, request.form.get('password', ''), request.form.get('current_password', ''))
            except ValueError as error:
                flash(str(error), 'error')
            else:
                session.clear()
                flash('Password changed. Sign in again.', 'success')
                return redirect(url_for('login'))
        return render_template('account.html')

    @app.route('/users', methods=['GET', 'POST'])
    def users():
        if not g.user.is_admin:
            abort(403)
        if request.method == 'POST':
            try:
                action = request.form.get('action')
                if action == 'create':
                    store.create_user(request.form.get('username', '').strip(), request.form.get('password', ''), request.form.get('admin') == 'on')
                    flash('Account created.', 'success')
                elif action == 'toggle':
                    store.toggle_user(int(request.form.get('user_id', '0')), g.user.id)
                    flash('Account updated. Its existing sessions were revoked.', 'success')
                else:
                    raise ValueError('Unknown action.')
            except (ValueError, SQLAlchemyError) as error:
                flash(str(error) if isinstance(error, ValueError) else 'Cannot update that account.', 'error')
            return redirect(url_for('users'))
        return render_template('users.html', users=store.list_users())
