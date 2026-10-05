import { db, pool } from '@career/db';
import { sql } from 'drizzle-orm';
import { lockJobIdentity } from './job-identity.js';
import { effectiveSeenAtSql, isNewJobSql, markJobReviewed, reviewedJobsCte, sameVacancySql } from './review-state.js';
type Source = {provider:string;name?:string;url:string;postedAt:string|null;fetchedAt?:string|null};
type ResultRow = {aiSummaryStates?: Record<string,string>;job:{id:string;title:string;company:string;location:string|null;canonical_url:string|null;availability:string;shortlist_decision:string};archived:boolean;saved:boolean;seen_at:string|null;matched_at:string;search_ids:string[];group_id:string;duplicate_count:number;identity_conflict:boolean;score:number;reasons:string[];location_status:string;unknown_location:boolean;source_lists:Source[][];autoPreparedAt:string|null;autoPrepareError:string|null;applicationId:string|null;documentId:string|null;applicationState:string|null;documentApprovalStatus:string|null};
export type ResultQuery = { limit?: string; offset?: string; view?: string; sort?: string };
import { latestSearchRun } from './search-execution.js';

/** Rank and paginate in PostgreSQL. A running/failed refresh retains the last published results.
 * Materialized stages bound later joins. Identity conflicts use indexed per-identity lookups:
 * joining a full grouped identity CTE can cause quadratic scans before autovacuum has statistics.
 */
export async function searchResults(workspaceId: string, searchId: string | null, query: ResultQuery) {
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? '20', 10) || 20));
  const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(query.offset ?? '0', 10) || 0));
  const view = ['new','all','saved','archived'].includes(query.view ?? '') ? query.view : 'all';
  const order = query.sort === 'recent' ? 'posted_at DESC NULLS LAST,score DESC' : 'score DESC,posted_at DESC NULLS LAST';
  const { rows } = await pool.query(`WITH selected AS MATERIALIZED (
    SELECT s.* FROM saved_job_searches s WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id=$2)
  ), latest AS MATERIALIZED (
    SELECT s.id AS search_id,r.id AS run_id FROM selected s JOIN LATERAL (
      SELECT x.id FROM search_runs x WHERE x.workspace_id=s.workspace_id AND x.search_id=s.id AND x.criteria @> jsonb_build_object('role',s.role,'company',s.company,'location',s.location,'workMode',s.work_mode,'includeRelated',s.include_related,'matcherVersion',s.matcher_version) AND x.criteria->'providerIds'=s.provider_ids
      AND (EXISTS(SELECT 1 FROM search_run_results rr WHERE rr.run_id=x.id) OR x.status='SUCCEEDED')
      ORDER BY x.created_at DESC,x.id DESC LIMIT 1
    ) r ON true
  ), matches AS MATERIALIZED (
    SELECT r.job_id,r.search_id,r.score,r.reasons,r.location_status,r.unknown_location,r.posted_at,r.sources,v.seen_at,v.first_matched_at AS matched_at
    FROM latest l JOIN search_run_results r ON r.run_id=l.run_id AND r.workspace_id=$1
    JOIN search_job_reviews v ON v.workspace_id=r.workspace_id AND v.search_id=r.search_id AND v.job_id=r.job_id
    UNION ALL
    SELECT m.job_id,m.search_id,0,'[]'::jsonb,'unknown',true,NULL,
      coalesce((SELECT jsonb_agg(jsonb_build_object('provider',src.provider,'name',src.provider,'url',src.source_url,'postedAt',src.posted_at)) FROM job_search_sources src WHERE src.workspace_id=m.workspace_id AND src.job_id=m.job_id),'[]'::jsonb),
      coalesce(v.seen_at,j.seen_at),m.matched_at FROM saved_job_search_matches m JOIN jobs j ON j.workspace_id=m.workspace_id AND j.id=m.job_id JOIN selected s ON s.id=m.search_id AND s.matcher_version=1
      LEFT JOIN search_job_reviews v ON v.workspace_id=m.workspace_id AND v.search_id=m.search_id AND v.job_id=m.job_id WHERE m.workspace_id=$1
      AND (s.role IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(regexp_split_to_array(lower(translate(s.role,'áéíóúñ','aeioun')),'\\s+')) term WHERE position(term in lower(translate(j.title,'áéíóúñ','aeioun')))=0))
      AND (s.company IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(regexp_split_to_array(lower(translate(s.company,'áéíóúñ','aeioun')),'\\s+')) term WHERE position(term in lower(translate(j.company,'áéíóúñ','aeioun')))=0))
      AND (s.work_mode='any' OR EXISTS(SELECT 1 FROM job_search_sources src WHERE src.workspace_id=m.workspace_id AND src.job_id=m.job_id AND src.raw->>'__careerStackWorkMode'=s.work_mode))
      AND (s.location IS NULL OR j.location IS NULL OR trim(j.location)='' OR lower(j.location)~'(worldwide|anywhere|global|europe|emea|multiple locations|various locations|^remote( only)?$)'
        OR EXISTS(SELECT 1 FROM unnest(regexp_split_to_array(lower(translate(s.location,'áéíóúñ','aeioun')),'\\s+')) term WHERE position(term in lower(translate(j.location,'áéíóúñ','aeioun')))>0)
        OR (lower(s.location) IN ('spain','españa','espana') AND lower(j.location)~'(spain|españa|espana|spanish)')
        OR (lower(s.location) IN ('germany','alemania') AND lower(j.location)~'(germany|alemania|deutschland|german)')
        OR (lower(s.location) IN ('uk','united kingdom') AND lower(j.location)~'(uk|united kingdom|britain|england)')
        OR (lower(s.location) IN ('usa','united states') AND lower(j.location)~'(usa|united states|us)'))
  ), reviewed AS MATERIALIZED (${reviewedJobsCte('$1')}
  ), grouped AS MATERIALIZED (
    SELECT CASE WHEN ci.conflicted THEN j.id::text ELSE coalesce(im.identity_key,j.id::text) END AS group_id,
      (array_agg(j.id ORDER BY m.score DESC,j.created_at,j.id))[1] AS job_id,
      max(m.score) AS score,max(m.posted_at) AS posted_at,min(m.matched_at) AS matched_at,
      CASE WHEN bool_and(${effectiveSeenAtSql('j','rv')} IS NOT NULL) THEN max(${effectiveSeenAtSql('j','rv')}) ELSE NULL END AS seen_at,
      array_agg(DISTINCT m.search_id) AS search_ids,count(DISTINCT j.id)::int AS duplicate_count,
      bool_or(coalesce(ci.conflicted,false)) AS identity_conflict,
      (array_agg(m.reasons ORDER BY m.score DESC,j.id))[1] AS reasons,
      (array_agg(m.location_status ORDER BY m.score DESC,j.id))[1] AS location_status,
      bool_and(m.unknown_location) AS unknown_location,
      jsonb_agg(m.sources) AS source_lists,
      bool_or(j.shortlist_decision='ARCHIVED') AS archived,bool_or(j.shortlist_decision='SHORTLISTED') AS saved,
      bool_or(j.shortlist_decision='SKIPPED') AS skipped
    FROM matches m JOIN jobs j ON j.id=m.job_id AND j.workspace_id=$1
    LEFT JOIN reviewed rv ON rv.job_id=j.id
    LEFT JOIN job_identity_members im ON im.workspace_id=j.workspace_id AND im.job_id=j.id
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT member.shortlist_decision)>1 OR count(DISTINCT application.id)>1 AS conflicted
      FROM job_identity_members identity JOIN jobs member ON member.workspace_id=identity.workspace_id AND member.id=identity.job_id
      LEFT JOIN applications application ON application.workspace_id=member.workspace_id AND application.job_id=member.id
      WHERE identity.workspace_id=$1 AND identity.identity_key=im.identity_key
    ) ci ON true
    GROUP BY CASE WHEN ci.conflicted THEN j.id::text ELSE coalesce(im.identity_key,j.id::text) END
  ), filtered AS MATERIALIZED (
    SELECT * FROM grouped WHERE CASE $3 WHEN 'archived' THEN archived WHEN 'saved' THEN saved AND NOT archived
      WHEN 'new' THEN seen_at IS NULL AND NOT archived AND NOT saved AND NOT skipped ELSE NOT archived END
  ), page AS MATERIALIZED (SELECT * FROM filtered ORDER BY ${order},group_id LIMIT $4 OFFSET $5)
  SELECT (SELECT count(*)::int FROM filtered) AS total,
    coalesce((SELECT jsonb_agg(to_jsonb(page)||jsonb_build_object('job',to_jsonb(j),'autoPreparedAt',m.auto_prepared_at,'autoPrepareError',m.auto_prepare_error,'applicationId',a.id,'documentId',a.document_id,'applicationState',a.state,'documentApprovalStatus',a.approval_status,'aiSummaryStates',ai.states) ORDER BY ${order},group_id)
      FROM page JOIN jobs j ON j.id=page.job_id AND j.workspace_id=$1 LEFT JOIN LATERAL (
        SELECT auto_prepared_at,auto_prepare_error FROM saved_job_search_matches WHERE workspace_id=$1 AND job_id=page.job_id ORDER BY auto_prepared_at DESC NULLS LAST LIMIT 1
       ) m ON true LEFT JOIN LATERAL (
        SELECT a.id,a.document_id,a.state,d.approval_status FROM applications a LEFT JOIN document_versions d ON d.workspace_id=a.workspace_id AND d.id=a.document_id
        WHERE a.workspace_id=$1 AND (a.job_id=page.job_id OR a.job_id IN(SELECT im.job_id FROM job_identity_members im WHERE im.workspace_id=$1 AND im.identity_key=page.group_id))
        ORDER BY a.updated_at DESC,a.id LIMIT 1
      ) a ON true LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(locale,summary_state) AS states FROM (
          SELECT DISTINCT ON(r.snapshot->>'locale') r.snapshot->>'locale' AS locale,
            CASE WHEN r.status IN ('QUEUED','RUNNING','CANCEL_REQUESTED') THEN r.status
              WHEN r.status='SUCCEEDED' AND artifact.state IS NOT NULL AND artifact.state<>'DISMISSED' THEN 'SAVED'
              ELSE r.status END AS summary_state
          FROM ai_runs r LEFT JOIN ai_artifacts artifact ON artifact.workspace_id=r.workspace_id AND artifact.run_id=r.id
          WHERE r.workspace_id=$1 AND r.operation='JOB_ANALYSIS' AND r.snapshot->'job'->>'jobId'=page.job_id::text
            AND r.snapshot->>'locale' IN ('es','en')
          ORDER BY r.snapshot->>'locale',r.created_at DESC,r.id DESC
        ) recent
      ) ai ON true),'[]'::jsonb) AS items,
    (SELECT md5(coalesce(string_agg(run_id::text,',' ORDER BY search_id),'')) FROM latest)||':'||(SELECT count(*)::text FROM matches)||':'||(SELECT count(*) FILTER(WHERE seen_at IS NOT NULL)||':'||count(*) FILTER(WHERE archived OR saved OR skipped) FROM grouped) AS version`, [workspaceId,searchId,view,limit,offset]);
  const result = rows[0];
  return { total: result.total, resultVersion: result.version ?? 'legacy', latestRun: searchId ? await latestSearchRun(workspaceId,searchId) : null,
    items: result.items.map((r: ResultRow) => {
      const j = r.job; const sources = new Map<string, unknown>();
      for (const list of r.source_lists) for (const source of list) sources.set(`${source.provider}:${source.url}`,source);
      return { id:j.id,title:j.title,company:j.company,location:j.location,canonicalUrl:j.canonical_url,availability:j.availability,
        shortlistDecision:r.archived ? 'ARCHIVED' : r.saved ? 'SHORTLISTED' : j.shortlist_decision,
        seenAt:r.seen_at,matchedAt:r.matched_at,searchIds:r.search_ids,groupId:r.group_id,duplicateCount:r.duplicate_count,identityConflict:r.identity_conflict,
        searchScore:r.score,searchReasons:r.reasons,locationStatus:r.location_status,unknownLocation:r.unknown_location,
        aiSummaryStates:r.aiSummaryStates ?? {},sources:[...sources.values()],autoPreparedAt:r.autoPreparedAt,autoPrepareError:r.autoPrepareError,applicationId:r.applicationId,documentId:r.documentId,applicationState:r.applicationState,documentApprovalStatus:r.documentApprovalStatus };
    }) };
}

/** Reviewing from a search (or All searches) reviews the vacancy everywhere; the search scope only validates the request. */
export async function reviewSearchResult(workspaceId: string, searchId: string | null, jobId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockJobIdentity(tx, workspaceId);
    const listed = await tx.execute(sql`SELECT 1 FROM saved_job_search_matches m WHERE m.workspace_id=${workspaceId}
      AND (${searchId}::uuid IS NULL OR m.search_id=${searchId}::uuid) AND m.job_id IN(${sameVacancySql(workspaceId, jobId)}) LIMIT 1`);
    if (!listed.rows.length) return false;
    await markJobReviewed(tx, workspaceId, jobId);
    return true;
  });
}

/** Counts reflect review/archive changes immediately, including jobs first found in another search. */
export async function searchUnreadCounts(workspaceId: string): Promise<Map<string,number>> {
  const {rows}=await pool.query(`WITH selected AS MATERIALIZED (SELECT * FROM saved_job_searches WHERE workspace_id=$1), latest AS MATERIALIZED (
    SELECT s.id AS search_id,r.id AS run_id FROM selected s JOIN LATERAL (
      SELECT x.id FROM search_runs x WHERE x.workspace_id=s.workspace_id AND x.search_id=s.id
        AND x.criteria @> jsonb_build_object('role',s.role,'company',s.company,'location',s.location,'workMode',s.work_mode,'includeRelated',s.include_related,'matcherVersion',s.matcher_version)
        AND x.criteria->'providerIds'=s.provider_ids AND (x.status='SUCCEEDED' OR EXISTS(SELECT 1 FROM search_run_results z WHERE z.run_id=x.id)) ORDER BY x.created_at DESC,x.id DESC LIMIT 1
    ) r ON true WHERE s.matcher_version=2
  ), matches AS MATERIALIZED (
    SELECT rr.search_id,rr.job_id,2 AS version FROM latest l JOIN search_run_results rr ON rr.run_id=l.run_id AND rr.workspace_id=$1
    UNION ALL SELECT m.search_id,m.job_id,1 FROM saved_job_search_matches m JOIN selected s ON s.id=m.search_id AND s.matcher_version=1 WHERE m.workspace_id=$1
  ), joined AS MATERIALIZED (
    SELECT m.search_id,j.id,j.seen_at,j.shortlist_decision FROM matches m JOIN jobs j ON j.workspace_id=$1 AND j.id=m.job_id
  ), fresh AS MATERIALIZED (SELECT search_id,id FROM joined j WHERE ${isNewJobSql('j','$1')} -- filter after the join so it cannot reorder the scans
  ) SELECT m.search_id,count(DISTINCT CASE WHEN ci.conflicted THEN m.id::text ELSE coalesce(im.identity_key,m.id::text) END)::int AS total
    FROM fresh m LEFT JOIN job_identity_members im ON im.workspace_id=$1 AND im.job_id=m.id
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT member.shortlist_decision)>1 OR count(DISTINCT application.id)>1 AS conflicted
      FROM job_identity_members identity JOIN jobs member ON member.workspace_id=identity.workspace_id AND member.id=identity.job_id
      LEFT JOIN applications application ON application.workspace_id=member.workspace_id AND application.job_id=member.id
      WHERE identity.workspace_id=$1 AND identity.identity_key=im.identity_key
    ) ci ON true
    GROUP BY m.search_id`,[workspaceId]);
  return new Map(rows.map(row=>[row.search_id,row.total]));
}
