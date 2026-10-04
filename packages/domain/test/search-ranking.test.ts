import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSearchMatch,providerSearchRole} from '../src/search-matching.js';

// Additional synthetic ranking probes, separate from the binary development corpus.
// These describe explicit role/country requirements, not measured user satisfaction.
const families = [
 {role:'quality assurance',aliases:['QA Engineer','Quality Assurance Engineer','Ingeniero de pruebas','Ingeniera QA','Tester de software'],noise:['SDET','Test automation engineer','Sales Representative','Software Engineer','Office Manager']},
 {role:'software engineer',aliases:['Software Engineer','Software Developer','Ingeniero de software','Ingeniera de software','Desarrolladora de software'],noise:['Frontend Developer','Web Developer','QA Analyst','Technical Support','Receptionist']},
 {role:'product designer',aliases:['Product Designer','Diseñador de producto','Diseñadora de producto','Senior Product Designer','Product Designer, B2B'],noise:['UX Designer','UI Designer','Service Designer','Product Manager','Graphic Artist']},
 {role:'customer support',aliases:['Customer Support Specialist','Customer Service Agent','Agente de atención al cliente','Soporte al cliente','Customer Service Representative'],noise:['Technical Support','Help Desk Analyst','Account Executive','Software Developer','Sales Manager']},
 {role:'digital marketing specialist',aliases:['Digital Marketing Specialist','Especialista en marketing digital','Senior Digital Marketing Specialist','Digital Marketing Specialist, retail','Especialista en marketing digital, B2B'],noise:['Marketing Specialist','SEO Specialist','Growth Marketer','Content Marketer','Account Manager']},
 {role:'administrative assistant',aliases:['Administrative Assistant','Asistente administrativo','Asistente administrativa','Auxiliar administrativo','Auxiliar administrativa'],noise:['Office Manager','Executive Assistant','Receptionist','Office Administrator','Administrative Coordinator']},
];

test('six families rank ten relevant synthetic jobs above unrelated or country-excluded jobs',()=>{
 const summaries=[];
 for(const family of families){
  const expected=family.aliases.flatMap((title,i)=>[0,1].map(copy=>({id:`yes-${i}-${copy}`,title,company:`Fictional ${copy}`,location:'Spain',countries:['ES'],workMode:'remote',relevant:true})));
  const rejected=[...family.noise.map((title,i)=>({id:`role-no-${i}`,title,company:'Fictional',location:'Spain',countries:['ES'],workMode:'remote',relevant:false})),...family.aliases.map((title,i)=>({id:`country-no-${i}`,title,company:'Fictional',location:'United States only',countries:['US'],workMode:'remote',relevant:false}))];
  const ranked=[...rejected,...expected].map(job=>({job,match:evaluateSearchMatch(job,{role:family.role,company:null,location:'ES',workMode:'remote',includeRelated:false,matcherVersion:2})})).filter(row=>row.match.matched).sort((a,b)=>b.match.score-a.match.score||a.job.id.localeCompare(b.job.id)).slice(0,10);
  const precision=ranked.filter(row=>row.job.relevant).length/10;
  assert.equal(ranked.length,10,`${family.role}: fewer than ten relevant results`);
  assert.ok(precision>=0.8,`${family.role}: P@10=${precision}`);
  summaries.push(`${family.role}: P@10=${precision.toFixed(2)}`);
 }
 console.info(`Synthetic ranking: ${summaries.join('; ')}`);
});
test('canonical source query translates supported phrases while preserving modifiers',()=>{
 assert.equal(providerSearchRole('Java ingeniero de software'),'java software engineer');
 assert.equal(providerSearchRole('Especialista en marketing digital'),'digital marketing specialist');
 assert.equal(providerSearchRole('Senior SDET'),'senior sdet');
 assert.equal(providerSearchRole('bibliotecaria'),'bibliotecaria');
});
