import os
from pathlib import Path
import tempfile
import time
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select, update

from sentinel_atlas import create_app
from sentinel_atlas.auth import persistent_key
from sentinel_atlas.database import AccountStore, LoginSession, User, database_url
from sentinel_atlas.monitoring.demo import DemoMonitor


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.app=create_app(DemoMonitor(),{'TESTING':True,'DATABASE_URL':'sqlite://',
            'SECRET_KEY':'test-only-key-'*4,'DEFAULT_ACCOUNT':'admin','DEFAULT_PASSWORD':'first-password'})
        self.client=self.app.test_client()
        self.store=self.app.extensions['accounts']
        self.addCleanup(self.store.engine.dispose)

    def token(self, client=None):
        client=client or self.client
        client.get('/login')
        with client.session_transaction() as state:
            return state['csrf']

    def login(self, username='admin',password='first-password',next='/',client=None):
        client=client or self.client
        return client.post('/login?next='+next,data={'username':username,'password':password,'csrf_token':self.token(client)})

    def post(self,path,data=None):
        with self.client.session_transaction() as state:
            csrf=state['csrf']
        return self.client.post(path,data=dict(data or {},csrf_token=csrf))

    def test_all_monitoring_and_logs_require_login(self):
        health=self.client.get('/healthz')
        self.assertEqual(health.status_code,200)
        self.assertEqual(health.json,{'status':'ok'})
        self.assertEqual(self.client.get('/').status_code,302)
        for path in ('/api/cluster','/api/logs/redis2/redis','/api/logs/redis2/sentinel'):
            response=self.client.get(path)
            self.assertEqual(response.status_code,401)
            self.assertNotIn('192.168.10.',response.get_data(as_text=True))
        self.assertEqual(self.client.post('/api/refresh').status_code,401)
        response=self.login()
        self.assertEqual(response.status_code,302)
        self.assertEqual(self.client.get('/api/cluster').status_code,200)
        self.assertIn('HttpOnly',response.headers['Set-Cookie'])
        self.assertIn('SameSite=Lax',response.headers['Set-Cookie'])
        with self.store.session() as db:
            self.assertNotEqual(db.scalar(select(User.password_hash)),'first-password')

    def test_csrf_wrong_password_throttling_and_redirects(self):
        self.assertEqual(self.client.post('/login',data={'username':'admin','password':'first-password'}).status_code,400)
        for _ in range(5):
            self.assertEqual(self.login(password='wrong-password').status_code,401)
        self.assertEqual(self.login().status_code,429)
        other=self.app.test_client()
        token=self.token(other)
        response=other.post('/login?next=//evil.example',data={'username':'admin','password':'first-password','csrf_token':token},environ_base={'REMOTE_ADDR':'127.0.0.2'})
        self.assertEqual(response.location,'/')
        self.assertEqual(other.post('/api/refresh').status_code,400)

    def test_revocation_expiration_and_password_change(self):
        self.login()
        other=self.app.test_client();self.login(client=other)
        response=self.post('/account',{'current_password':'wrong','password':'second-password'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.client.get('/api/cluster').status_code,200)
        response=self.post('/account',{'current_password':'first-password','password':'second-password'})
        self.assertEqual(response.status_code,302)
        self.assertEqual(other.get('/api/cluster').status_code,401)
        self.assertEqual(self.client.get('/api/cluster').status_code,401)
        self.assertEqual(self.login(password='second-password').status_code,302)
        with self.store.session.begin() as db:
            db.execute(update(LoginSession).values(expires_at=time.time()-1))
        self.assertEqual(self.client.get('/api/cluster').status_code,401)

    def test_admin_creates_accounts_viewer_cannot_admin_and_disable_revokes(self):
        self.login()
        self.post('/users',{'action':'create','username':'viewer','password':'viewer-password'})
        viewer=self.app.test_client();self.login('viewer','viewer-password',client=viewer)
        self.assertEqual(viewer.get('/users').status_code,403)
        self.assertEqual(viewer.get('/api/cluster').status_code,200)
        user=next(user for user in self.store.list_users() if user.username=='viewer')
        self.post('/users',{'action':'toggle','user_id':str(user.id)})
        self.assertEqual(viewer.get('/api/cluster').status_code,401)
        self.post('/logout')
        self.assertEqual(self.client.get('/api/cluster').status_code,401)

    def test_bootstrap_persists_and_does_not_reset_existing_password(self):
        with tempfile.TemporaryDirectory() as folder:
            url='sqlite:///'+str(Path(folder)/'accounts.db')
            one=AccountStore(url)
            try: one.bootstrap('first','first-password')
            finally: one.engine.dispose()
            two=AccountStore(url)
            try:
                two.bootstrap('different','different-password')
                self.assertEqual([user.username for user in two.list_users()],['first'])
                user,_=two.authenticate('first','first-password','test-address')
                self.assertIsNotNone(user)
            finally: two.engine.dispose()
            key=persistent_key(Path(folder)/'instance')
            self.assertEqual(key,persistent_key(Path(folder)/'instance'))
            if os.name!='nt': self.assertEqual((Path(folder)/'instance/session.key').stat().st_mode & 0o777,0o600)
        self.assertEqual(database_url('postgresql://user:pass@localhost/db').drivername,'postgresql+psycopg')

    def test_missing_initial_password_fails_without_insecure_default(self):
        with self.assertRaisesRegex(ValueError,'DEFAULT_PASSWORD'):
            create_app(DemoMonitor(),{'DATABASE_URL':'sqlite://','SECRET_KEY':'x'*40,'DEFAULT_PASSWORD':None})

    def test_instance_override_keeps_database_and_signing_key_together(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{
            'SENTINEL_INSTANCE_PATH':folder,'SENTINEL_ENV_FILE':os.devnull,
            'DEFAULT_ACCOUNT':'owner','DEFAULT_PASSWORD':'owner-password'},clear=True):
            app=create_app(DemoMonitor())
            try:
                self.assertEqual(Path(app.instance_path),Path(folder).resolve())
                self.assertTrue((Path(folder)/'atlas.sqlite').is_file())
                self.assertTrue((Path(folder)/'session.key').is_file())
            finally:app.extensions['accounts'].engine.dispose()

    def test_lowercase_bootstrap_environment_names_are_supported(self):
        with patch.dict(os.environ,{'default_account':'owner','default_password':'owner-password',
            'database_url':'sqlite://','secret_key':'test-lowercase-key-'*3},clear=True):
            app=create_app(DemoMonitor())
            try:
                self.assertEqual(app.extensions['accounts'].list_users()[0].username,'owner')
            finally:app.extensions['accounts'].engine.dispose()
