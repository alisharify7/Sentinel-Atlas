"""Profile changes and public links must preserve account and cluster boundaries."""
import copy
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import select, update

from sentinel_atlas import create_app
from sentinel_atlas.database import AccountStore, ShareLink, User, digest
from sentinel_atlas.monitoring.demo import DemoMonitor
from sentinel_atlas.monitoring.monitor import ClusterState


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.monitor = DemoMonitor()
        self.app = create_app(self.monitor, {'TESTING': True, 'DATABASE_URL': 'sqlite://',
            'SECRET_KEY': 'workspace-test-key-' * 3, 'DEFAULT_ACCOUNT': 'owner', 'DEFAULT_PASSWORD': 'owner-password'})
        self.store = self.app.extensions['accounts']
        self.addCleanup(self.store.engine.dispose)
        self.client = self.app.test_client()
        self.viewer = self.app.test_client()
        self.login(self.client)

    def login(self, client, username='owner', password='owner-password'):
        client.get('/login')
        with client.session_transaction() as session:
            csrf = session['csrf']
        return client.post('/login', data={'username': username, 'password': password, 'csrf_token': csrf})

    def post(self, path, data, client=None):
        client = client or self.client
        with client.session_transaction() as session:
            csrf = session['csrf']
        return client.post(path, data=dict(data, csrf_token=csrf))

    def create_link(self, **options):
        result = self.post('/shares', dict({'label': 'Incident handoff', 'cluster': 'redis-main', 'duration': '3600'}, **options))
        self.assertEqual(result.status_code, 302)
        with self.client.session_transaction() as session:
            share = session['new_share']
        return share['id'], share['token']

    def test_pages_are_distinct_and_navigation_is_not_anchor_scrolling(self):
        expected = {'/': 'attentionList', '/live': 'graphViewport', '/instances': 'fleetSearch',
                    '/logs': 'logOutput', '/activity': 'eventFilter', '/profile': 'Profile &amp; preferences', '/shares': 'Generate viewing link', '/about': 'Ali Sharify'}
        for path, marker in expected.items():
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                html = response.get_data(as_text=True)
                self.assertIn(marker, html)
                if path != '/live':
                    self.assertNotIn('id="graphViewport"', html)
                if path != '/logs':
                    self.assertNotIn('id="logOutput"', html)
                self.assertIn('aria-current="page"', html)
                self.assertNotIn('href="#topology"', html)
                self.assertEqual(self.viewer.get(path).status_code, 302)
        about = self.client.get('/about').get_data(as_text=True)
        for link in ('https://github.com/alisharify7', 'https://ali-sharify.ir', 'https://github.com/alisharify7/Sentinel-Atlas/issues'):
            self.assertIn(link, about)
        self.assertIn('GPL-2.0', about)
        self.assertIn('open source community', self.viewer.get('/login').get_data(as_text=True))

    def test_profile_username_validation_and_session_controls(self):
        other = self.app.test_client()
        self.login(other)
        values = {'action': 'profile', 'username': 'new-owner', 'display_name': '<Owner>',
                  'email': 'owner@example.com', 'organization': 'Operations', 'timezone': 'Asia/Tehran', 'bio': 'On call'}
        self.post('/profile', values)
        self.assertEqual(self.store.list_users()[0].username, 'owner')
        response = self.post('/profile', dict(values, current_password='owner-password'))
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.list_users()[0].username, 'new-owner')
        self.assertEqual(self.store.profile(self.store.list_users()[0].id).timezone, 'Asia/Tehran')
        page = self.client.get('/profile').get_data(as_text=True)
        self.assertIn('&lt;Owner&gt;', page)
        self.assertNotIn('value="<Owner>"', page)
        self.post('/profile', dict(values, timezone='Not/AZone'))
        self.assertEqual(self.store.profile(self.store.list_users()[0].id).timezone, 'Asia/Tehran')
        self.post('/profile', {'action': 'sessions'})
        self.assertEqual(self.client.get('/api/cluster').status_code, 200)
        self.assertEqual(other.get('/api/cluster').status_code, 401)
        self.post('/profile', {'action': 'password', 'current_password': 'owner-password',
                  'password': 'replacement-password', 'password_confirm': 'different-password'})
        self.assertEqual(self.client.get('/api/cluster').status_code, 200)
        self.post('/profile', {'action': 'password', 'current_password': 'owner-password',
                  'password': 'replacement-password', 'password_confirm': 'replacement-password'})
        self.assertEqual(self.client.get('/api/cluster').status_code, 401)
        self.assertEqual(self.login(self.viewer, 'new-owner', 'replacement-password').status_code, 302)

    def test_graph_only_link_omits_configuration_logs_details_and_other_permissions(self):
        link_id, token = self.create_link()
        html = self.viewer.get('/s/' + token).get_data(as_text=True)
        self.assertIn('Shared · Read only', html)
        self.assertNotIn('href="/shares', html)
        self.assertNotIn('id="logOutput"', html)
        response = self.viewer.get(f'/s/{token}/api/cluster?cluster=some-other-cluster&config=on&logs=on')
        self.assertEqual(response.status_code, 200)
        data = response.json
        self.assertEqual(data['clusters'], ['redis-main'])
        self.assertEqual(data['events'], [])
        for node in data['nodes']:
            self.assertNotIn('configuration', node['redis'])
            for key in ('logfile', 'config_file', 'data_directory'):
                self.assertNotIn(key, node['redis'])
            self.assertEqual(node['hardware'], {})
            self.assertEqual(node['storage'], [])
            self.assertNotIn('storage', node['metadata'])
            self.assertNotIn('container', node['metadata'])
        for path in (f'/s/{token}/logs', f'/s/{token}/activity', f'/s/{token}/api/logs/redis1/redis'):
            self.assertEqual(self.viewer.get(path).status_code, 403)
        self.assertEqual(self.viewer.get('/api/cluster').status_code, 401)
        self.assertEqual(self.viewer.post('/api/refresh').status_code, 401)
        with self.store.session() as db:
            link = db.get(ShareLink, link_id)
            self.assertEqual(link.token_hash, digest(token))
            self.assertNotEqual(link.token_hash, token)
            self.assertIsNotNone(link.last_used_at)
        self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
        self.assertIn('noindex', response.headers['X-Robots-Tag'])

    def test_full_access_read_only_link_and_one_time_copy(self):
        _, token = self.create_link(config='on', logs='on', details='on', events='on', duration='permanent')
        self.assertIn(token, self.client.get('/shares').get_data(as_text=True))
        self.assertNotIn(token, self.client.get('/shares').get_data(as_text=True))
        data = self.viewer.get(f'/s/{token}/api/cluster').json
        self.assertIn('configuration', data['nodes'][0]['redis'])
        self.assertEqual(data['nodes'][0]['redis']['configuration']['requirepass'], '[REDACTED]')
        self.assertTrue(data['nodes'][0]['storage'])
        self.assertTrue(data['events'])
        for path in (f'/s/{token}/logs', f'/s/{token}/activity', f'/s/{token}/api/logs/redis1/redis'):
            self.assertEqual(self.viewer.get(path).status_code, 200)
        self.assertEqual(self.viewer.get(f'/s/{token}/api/logs/not-a-node/redis').status_code, 404)
        self.assertEqual(self.viewer.get(f'/s/{token}/api/logs/redis1/shell').status_code, 404)
        self.assertNotEqual(self.viewer.post(f'/s/{token}/api/refresh').status_code, 202)

    def test_each_optional_permission_is_independent(self):
        for scope in ('config', 'logs', 'details', 'events'):
            with self.subTest(scope=scope):
                _, token = self.create_link(**{scope: 'on'})
                data = self.viewer.get(f'/s/{token}/api/cluster').json
                self.assertEqual('configuration' in data['nodes'][0]['redis'], scope == 'config')
                self.assertEqual(bool(data['nodes'][0]['hardware']), scope == 'details')
                self.assertEqual(bool(data['nodes'][0]['storage']), scope == 'details')
                self.assertEqual(bool(data['events']), scope == 'events')
                self.assertEqual(self.viewer.get(f'/s/{token}/api/logs/redis1/redis').status_code, 200 if scope == 'logs' else 403)

    def test_profile_cannot_change_roles_or_take_an_existing_username(self):
        self.store.create_user('member', 'member-password')
        member = self.app.test_client()
        self.login(member, 'member', 'member-password')
        self.post('/profile', {'action': 'profile', 'username': 'owner', 'current_password': 'member-password'}, member)
        self.assertEqual([user.username for user in self.store.list_users()], ['member', 'owner'])
        self.post('/profile', {'action': 'profile', 'username': 'member', 'is_admin': 'on', 'active': 'on', 'timezone': 'UTC'}, member)
        self.assertEqual(member.get('/users').status_code, 403)

    def test_expiry_revocation_owner_disabled_and_no_cross_owner_revoke(self):
        link_id, token = self.create_link()
        with patch('sentinel_atlas.sharing.time.time', return_value=time.time() + 3601):
            self.assertEqual(self.viewer.get(f'/s/{token}').status_code, 404)
            self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 404)
        self.post('/shares', {'action': 'revoke', 'link_id': link_id})
        self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 404)
        link_id, token = self.create_link(duration='permanent')
        self.store.create_user('other', 'other-password')
        other = self.app.test_client()
        self.login(other, 'other', 'other-password')
        self.assertEqual(self.post('/shares', {'action': 'revoke', 'link_id': link_id}, other).status_code, 404)
        self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 200)
        with self.store.session.begin() as db:
            db.execute(update(User).where(User.username == 'owner').values(active=False))
        self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 404)

    def test_disabling_and_reenabling_an_owner_does_not_restore_links(self):
        _, token = self.create_link(duration='permanent')
        self.store.create_user('administrator', 'admin-password', admin=True)
        users = {user.username: user for user in self.store.list_users()}
        self.store.toggle_user(users['owner'].id, users['administrator'].id)
        self.store.toggle_user(users['owner'].id, users['administrator'].id)
        self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 404)

    def test_validation_csrf_and_missing_tokens(self):
        self.assertEqual(self.client.post('/shares', data={'label': 'No CSRF'}).status_code, 400)
        for fields in ({'cluster': 'unknown'}, {'duration': '-1'}, {'label': ''}, {'label': 'x'*101}):
            self.post('/shares', dict({'cluster': 'redis-main', 'duration': '3600', 'label': 'Example'}, **fields))
        with self.store.session() as db:
            self.assertEqual(list(db.scalars(select(ShareLink))), [])
        for token in ('short', 'x'*64):
            self.assertEqual(self.viewer.get('/s/' + token).status_code, 404)

    def test_edit_preserves_url_cluster_and_expiry_and_updates_access(self):
        link_id, token = self.create_link(config='on', logs='on', details='on', events='on')
        before = self.viewer.get(f'/s/{token}/api/cluster').json
        with self.store.session() as db:
            previous = db.get(ShareLink, link_id)
            expiry, created = previous.expires_at, previous.created_at
        response = self.client.get(f'/shares?edit={link_id}')
        self.assertEqual(response.status_code, 200)
        self.assertIn('value="keep" selected', response.get_data(as_text=True))
        self.post('/shares', {'action': 'edit', 'link_id': link_id, 'label': 'Status board', 'duration': 'keep', 'cluster': 'another-cluster'})
        after = self.viewer.get(f'/s/{token}/api/cluster').json
        self.assertNotEqual(before['share_revision'], after['share_revision'])
        self.assertNotIn('configuration', after['nodes'][0]['redis'])
        self.assertEqual(after['nodes'][0]['hardware'], {})
        self.assertEqual(after['events'], [])
        self.assertEqual(self.viewer.get(f'/s/{token}/api/logs/redis1/redis').status_code, 403)
        with self.store.session() as db:
            link = db.get(ShareLink, link_id)
            self.assertEqual(link.label, 'Status board')
            self.assertEqual(link.token_hash, digest(token))
            self.assertEqual(link.cluster, 'redis-main')
            self.assertEqual(link.expires_at, expiry)
            self.assertEqual(link.created_at, created)
        self.assertIn('Status board', self.viewer.get(f'/s/{token}').get_data(as_text=True))
        self.post('/shares', {'action': 'edit', 'link_id': link_id, 'label': 'Status board', 'duration': 'permanent', 'config': 'on', 'logs': 'on'})
        with self.store.session() as db:
            self.assertIsNone(db.get(ShareLink, link_id).expires_at)
        self.assertIn('configuration', self.viewer.get(f'/s/{token}/api/cluster').json['nodes'][0]['redis'])
        self.assertEqual(self.viewer.get(f'/s/{token}/api/logs/redis1/redis').status_code, 200)

    def test_edit_can_renew_expired_links_but_not_revoked_links(self):
        link_id, token = self.create_link()
        with self.store.session.begin() as db:
            db.get(ShareLink, link_id).expires_at = time.time()-1
        self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 404)
        now = time.time()
        self.post('/shares', {'action': 'edit', 'link_id': link_id, 'label': 'Renewed', 'duration': '3600'})
        self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 200)
        with self.store.session() as db:
            expiry = db.get(ShareLink, link_id).expires_at
            self.assertGreaterEqual(expiry, now+3600)
            self.assertLess(expiry, time.time()+3601)
        self.post('/shares', {'action': 'revoke', 'link_id': link_id})
        self.post('/shares', {'action': 'edit', 'link_id': link_id, 'label': 'Reactivated', 'duration': 'permanent'})
        self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 404)
        with self.store.session() as db:
            self.assertEqual(db.get(ShareLink, link_id).label, 'Renewed')

    def test_delete_disables_url_and_removes_active_expired_and_revoked_links(self):
        for state in ('active', 'expired', 'revoked'):
            with self.subTest(state=state):
                link_id, token = self.create_link()
                if state == 'expired':
                    with self.store.session.begin() as db:
                        db.get(ShareLink, link_id).expires_at = time.time()-1
                elif state == 'revoked':
                    self.post('/shares', {'action': 'revoke', 'link_id': link_id})
                self.assertEqual(self.client.get(f'/shares?delete={link_id}').status_code, 200)
                with self.store.session() as db:
                    self.assertIsNotNone(db.get(ShareLink, link_id), 'Opening the confirmation must not delete a link')
                self.post('/shares', {'action': 'delete', 'link_id': link_id})
                with self.store.session() as db:
                    self.assertIsNone(db.get(ShareLink, link_id))
                self.assertEqual(self.viewer.get(f'/s/{token}').status_code, 404)
                self.assertEqual(self.viewer.get(f'/s/{token}/api/cluster').status_code, 404)

    def test_edit_and_delete_enforce_ownership_csrf_and_atomic_validation(self):
        link_id, token = self.create_link(logs='on')
        self.store.create_user('other', 'other-password')
        other = self.app.test_client()
        self.login(other, 'other', 'other-password')
        for action in ('edit', 'delete'):
            self.assertEqual(self.client.post('/shares', data={'action': action, 'link_id': link_id}).status_code, 400)
            self.assertEqual(self.client.get(f'/shares?{action}=not-an-id').status_code, 404)
            self.assertEqual(other.get(f'/shares?{action}={link_id}').status_code, 404)
            self.assertEqual(self.post('/shares', {'action': action, 'link_id': link_id, 'label': 'Stolen'}, other).status_code, 404)
            self.assertEqual(self.post('/shares', {'action': action, 'link_id': 999999, 'label': 'Missing'}).status_code, 404)
        for values in ({'label': ''}, {'label': 'x'*101}, {'duration': 'invalid'}):
            self.post('/shares', dict({'action': 'edit', 'link_id': link_id, 'label': 'Invalid update', 'duration': 'keep'}, **values))
        with self.store.session() as db:
            link = db.get(ShareLink, link_id)
            self.assertEqual(link.label, 'Incident handoff')
            self.assertTrue(link.allow_logs)
        self.assertEqual(self.viewer.get(f'/s/{token}/api/logs/redis1/redis').status_code, 200)

    def test_cluster_scoping_includes_events_and_logs_and_never_falls_back(self):
        demo = self.monitor.sample()
        records = {}
        for cluster in ('alpha', 'beta'):
            for node in demo['nodes']:
                name = cluster + '-' + node['name']
                records[name] = {'metadata': dict(node['metadata'], name=name, cluster=cluster),
                    'telemetry': {key: copy.deepcopy(node[key]) for key in ('redis','sentinel','hardware','container','storage')}}
        state = ClusterState()
        state.apply(records)
        app = create_app(state, {'TESTING': True, 'DATABASE_URL': 'sqlite://', 'SECRET_KEY': 'scope-test-'*4,
            'DEFAULT_ACCOUNT': 'owner', 'DEFAULT_PASSWORD': 'owner-password'})
        self.addCleanup(app.extensions['accounts'].engine.dispose)
        original_app, original_client, original_store = self.app, self.client, self.store
        self.app, self.client, self.store = app, app.test_client(), app.extensions['accounts']
        try:
            self.login(self.client)
            _, token = self.create_link(cluster='alpha', logs='on', events='on')
            viewer = app.test_client()
            data = viewer.get(f'/s/{token}/api/cluster?cluster=beta').json
            self.assertEqual(data['cluster'], 'alpha')
            self.assertTrue(all(node['name'].startswith('alpha-') for node in data['nodes']))
            self.assertTrue(all(event['cluster'] == 'alpha' for event in data['events']))
            self.assertNotIn('beta-', str(data))
            self.assertEqual(viewer.get(f'/s/{token}/api/logs/beta-redis1/redis').status_code, 404)
            state.apply({name: record for name, record in records.items() if name.startswith('beta-')})
            self.assertEqual(viewer.get(f'/s/{token}/api/cluster').status_code, 404)
            self.assertEqual(viewer.get(f'/s/{token}').status_code, 404)
        finally:
            self.app, self.client, self.store = original_app, original_client, original_store

    def test_profile_and_links_survive_database_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            url = 'sqlite:///' + str(Path(directory) / 'accounts.sqlite')
            first = AccountStore(url)
            first.bootstrap('owner', 'owner-password')
            user = first.list_users()[0]
            first.update_profile(user.id, 'owner', {'display_name': 'Operations', 'timezone': 'UTC'})
            with first.session.begin() as db:
                db.add(ShareLink(token_hash=digest('a'*64), owner_id=user.id, cluster='redis', label='Status'))
            first.engine.dispose()
            second = AccountStore(url)
            try:
                self.assertEqual(second.profile(user.id).display_name, 'Operations')
                with second.session() as db:
                    self.assertEqual(db.scalar(select(ShareLink.label)), 'Status')
            finally:
                second.engine.dispose()


if __name__ == '__main__':
    unittest.main()
