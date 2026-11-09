/* Reference files the CEO attaches to a job. The browser sends one file per request as raw bytes (the name in the
   URI-encoded x-filename header), so no multipart parser is needed; the quest service passes it to Hermes. */
import type { FastifyInstance } from 'fastify';
import { DEPARTMENT_ID_RE, QUEST_FILE_MAX_BYTES, QuestFileAddedSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { InvalidInputError, NotFoundError } from '../domain/errors.ts';

export function register(app: FastifyInstance, deps: AppServices) {
  app.register(async (inst) => {
    // scoped to this plugin: nowhere else accepts raw bodies
    inst.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: QUEST_FILE_MAX_BYTES }, (_req, body, done) => done(null, body));
    inst.post('/api/departments/:id/quests/:questId/files', async (req, reply) => {
      const { id, questId } = req.params as { id: string; questId: string };
      if (!DEPARTMENT_ID_RE.test(id)) throw new NotFoundError('department not found');
      if (!Buffer.isBuffer(req.body)) throw new InvalidInputError('send the file as application/octet-stream');
      const raw = req.headers['x-filename'];
      let filename = '';
      try { filename = typeof raw === 'string' ? decodeURIComponent(raw) : ''; } catch { /* left empty: rejected below */ }
      if (!filename.trim()) throw new InvalidInputError('the x-filename header is required');
      const type = req.headers['x-content-type'];
      const attachment = await deps.quests.addFile(id, questId, {
        filename, contentType: typeof type === 'string' ? type : null, bytes: new Uint8Array(req.body),
      });
      return reply.code(201).send(QuestFileAddedSchema.parse({ attachment }));
    });
  });
}
