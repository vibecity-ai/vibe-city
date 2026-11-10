/* A floor's env variables (the key cabinet on every floor). Values go in, never out. */
import type { FastifyInstance } from 'fastify';
import { DEPARTMENT_ID_RE, DepartmentEnvSchema, EnvNameSchema, EnvVarSetSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { NotFoundError } from '../domain/errors.ts';

export function register(app: FastifyInstance, deps: AppServices) {
  const params = (p: unknown) => {
    const { id, name } = p as { id: string; name?: string };
    if (!DEPARTMENT_ID_RE.test(id)) throw new NotFoundError('floor not found');
    return { id, name: name === undefined ? '' : EnvNameSchema.parse(name) };
  };
  app.get('/api/departments/:id/env', async (req) => DepartmentEnvSchema.parse({ vars: deps.deptEnv.list(params(req.params).id), warning: null }));
  app.put('/api/departments/:id/env/:name', async (req) => {
    const { id, name } = params(req.params);
    return DepartmentEnvSchema.parse(await deps.deptEnv.set(id, name, EnvVarSetSchema.parse(req.body).value));
  });
  app.delete('/api/departments/:id/env/:name', async (req) => {
    const { id, name } = params(req.params);
    return DepartmentEnvSchema.parse({ vars: await deps.deptEnv.remove(id, name), warning: null });
  });
}
