import { FakeServer, sendJson } from './fake-server.ts';
import type { Handler } from './fake-server.ts';

export const VALID_SID = 's%3AfunctionalTestCookie1234567890.sig';

export const defaultSubstack: Handler = (req, res) => {
  if (!String(req.headers.cookie ?? '').includes(`substack.sid=${VALID_SID}`)) return sendJson(res, { error: 'unauthorized' }, 401);
  const { method, path } = req;
  if (method === 'GET' && path === '/api/v1/user/profile/self') return sendJson(res, { id: 42, name: 'Ada Test', handle: 'ada' });
  if (method === 'POST' && path === '/api/v1/drafts') return sendJson(res, { id: 1001 });
  if (method === 'GET' && path === '/api/v1/drafts/1001') return sendJson(res, { id: 1001, draft_title: 'Titolo di prova' });
  if (method === 'GET' && path.startsWith('/api/v1/post_management/drafts')) return sendJson(res, { posts: [{ id: 1001, draft_title: 'Titolo di prova' }] });
  if (method === 'POST' && /^\/api\/v1\/drafts\/\d+\/(publish|scheduled_release)$/.test(path)) return sendJson(res, {});
  if (method === 'POST' && path === '/api/v1/comment/feed') return sendJson(res, { id: 'note-777' });
  return sendJson(res, { error: 'not found' }, 404);
};

export const startFakeSubstack = (handler = defaultSubstack): Promise<FakeServer> => FakeServer.start(handler);
