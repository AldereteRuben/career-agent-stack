import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AiAutomationError, aiAutomationPauseSchema, type AiAutomationService } from './ai/automation.js';
import { AiSourceError } from './ai/source-snapshot.js';

export function registerAiAutomationRoutes(app:FastifyInstance,workspace:(request:FastifyRequest)=>string,service:AiAutomationService){
  app.addHook('onRoute',route=>{
    if(!route.url.startsWith('/api/v1/ai/automation'))return;
    route.errorHandler=(error,_request,reply)=>{
      const code=error instanceof AiAutomationError||error instanceof AiSourceError?error.code:'AI_UNAVAILABLE';
      const status=code==='INVALID_INPUT'?400:code==='AI_POLICY_NOT_FOUND'?404:code==='AI_UNAVAILABLE'?503:code==='AI_TOO_MANY_PREVIEWS'?429:409;
      return reply.code(status).send({error:code});
    };
  });
  app.get('/api/v1/ai/automation',async(request,reply)=>{
    reply.header('Cache-Control','no-store');const query=z.object({locale:z.enum(['es','en']).default('es')}).strict().safeParse(request.query);
    if(!query.success)return reply.code(400).send({error:'INVALID_INPUT'});
    return service.list(workspace(request),query.data.locale);
  });
  app.post('/api/v1/ai/automation/preview',async(request,reply)=>{reply.header('Cache-Control','no-store');return service.preview(workspace(request),request.body);});
  app.post('/api/v1/ai/automation',async(request,reply)=>{reply.header('Cache-Control','no-store');return reply.code(201).send(await service.activate(workspace(request),request.body));});
  app.post('/api/v1/ai/automation/:id/pause',async(request,reply)=>{
    reply.header('Cache-Control','no-store');const params=z.object({id:z.string().uuid()}).strict().safeParse(request.params);const body=aiAutomationPauseSchema.safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'INVALID_INPUT'});
    return service.pause(workspace(request),params.data.id,body.data.expectedRevision);
  });
  app.addHook('onClose',()=>service.close());
}
