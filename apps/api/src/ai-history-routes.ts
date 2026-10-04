import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AiHistoryError, type AiHistoryService } from './ai/history.js';

export function registerAiHistoryRoutes(app:FastifyInstance,workspace:(request:FastifyRequest)=>string,service:AiHistoryService){
  app.addHook('onRoute',route=>{
    if(!route.url.startsWith('/api/v1/ai/history/'))return;
    route.errorHandler=(error,_request,reply)=>{
      const code=error instanceof AiHistoryError?error.code:'AI_UNAVAILABLE';
      return reply.code(code==='INVALID_INPUT'?400:code==='AI_UNAVAILABLE'?503:code==='AI_TOO_MANY_PREVIEWS'?429:409).send({error:code});
    };
  });
  app.get('/api/v1/ai/history/clear-preview',async(request,reply)=>{reply.header('Cache-Control','no-store');return service.preview(workspace(request));});
  app.post('/api/v1/ai/history/clear',async(request,reply)=>{reply.header('Cache-Control','no-store');return service.clear(workspace(request),request.body);});
  app.addHook('onClose',()=>service.close());
}
