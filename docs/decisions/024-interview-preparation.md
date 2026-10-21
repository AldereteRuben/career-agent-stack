# 024 — Interview preparation / Preparación de entrevistas

Status: **accepted** by the maintainer on 2026-10-20; implementation tracked in [#199](https://github.com/AldereteRuben/career-agent-stack/issues/199), [#200](https://github.com/AldereteRuben/career-agent-stack/issues/200), [#201](https://github.com/AldereteRuben/career-agent-stack/issues/201), [#202](https://github.com/AldereteRuben/career-agent-stack/issues/202), [#203](https://github.com/AldereteRuben/career-agent-stack/issues/203) and [#204](https://github.com/AldereteRuben/career-agent-stack/issues/204). Date: 2026-10-18. Tracks [issue #42](https://github.com/AldereteRuben/career-agent-stack/issues/42).

## Context

Interview preparation is roadmap milestone M8. The product needs a useful path that works without an AI account, while keeping any optional assistant request reviewable and bounded. It must use the exact application context without treating generated practice material as knowledge of a company's real interview.

## Proposal

### 1. Start with a useful no-AI foundation

V1 works without Codex. It builds a reviewable preparation plan from the exact saved job snapshot, the current interview stage and the submitted resume when known. It maps each recognised requirement to approved profile facts, marks unsupported requirements as unknown, and lets the person add their own notes and questions. Fixed templates turn those inputs into practice prompts and a prioritized study list. No answer or skill claim is generated or approved automatically.

The plan records the source and provenance of each item: job snapshot, approved profile fact, person-provided note, public company research selected by the person, fixed template, or assistant-generated practice suggestion. Public research must be added by the person; V1 does not crawl a company or claim that a practice question will appear in an interview.

### 2. Make Codex an optional, per-request aid

The person may ask a connected Codex account to suggest practice questions, progressively revealed coding hints, recruiter questions, or study items for one selected application. Before sending, show the complete payload and require explicit confirmation for that request. The payload is limited to the selected offer snapshot, selected submitted resume, approved facts relevant to the request, interview stage, and company research or notes the person explicitly selects. Do not send the full profile, unrelated applications, rejected or suggested facts, or private assessment material.

Assistant output is labeled as generated practice material and is not saved to the plan until the person accepts it. If Codex is unavailable or the person declines, the no-AI plan and fixed prompts remain usable. Remembered consent does not authorize later requests.

### 3. Keep mock sessions structured and preparation-only

An optional text mock asks one question at a time, waits for the answer, and probes a weak or unsupported answer before continuing. Feedback uses an explicit rubric covering correctness, specificity, evidence, structure, and trade-offs. It distinguishes missing evidence from an incorrect answer, does not invent STAR examples, and does not praise an incorrect answer as correct. The person can review, edit, or discard feedback and learning items.

V1 is text-only and preparation-only. It does not assist during a live interview or employer assessment, submit answers, access assessment systems, or use leaked/private test material. Voice, recording, retention settings, and any additional consent are outside this decision and require a separate decision. No feature infers personality or hiring suitability from accent, emotion, or speaking style.

### 4. Store only application-scoped preparation data

Preparation plans and sessions belong to one application and workspace. Store the selected input references and content hashes needed to show which offer snapshot, resume and approved facts were used, along with accepted prompts, answers, feedback and learning items. Do not duplicate full profile facts or resume files in session rows. Recompute whether referenced evidence is still current when a plan is opened; stale evidence is labeled and requires review before reuse.

The person can delete individual plans and sessions. Workspace export, encrypted backup/restore, and workspace deletion include this data and preserve workspace isolation. A session or completed exercise never changes approved profile facts or skill claims; the person must use the existing fact-review flow to propose and approve a change.

### 5. Split implementation after product review

If accepted, split work into independently reviewable tickets: application-scoped data model and lifecycle; no-AI requirement/evidence plan; consented Codex suggestions; one-question-at-a-time text mock and rubric; bilingual accessible UI; and fictional-data tests. Do not start schema or feature implementation until the scope and data-sharing proposal are accepted.

## Consequences

- Interview preparation remains useful without Codex, while assistant use is visible and optional.
- The plan can be audited back to its source and never implies that suggested questions are actual employer questions.
- Application-scoped sessions add personal data and therefore need explicit deletion, export, backup and restore coverage before release.
- Voice and live-interview help remain out of scope.

## Propuesta en español

### Contexto y decisión

La preparación de entrevistas es el hito M8. La primera versión debe servir sin una cuenta de IA. La ruta básica genera un plan revisable a partir de la oferta exacta guardada, la etapa actual y el CV enviado cuando se conozca: relaciona requisitos reconocidos con hechos aprobados, señala lo desconocido y permite añadir notas y preguntas propias. Plantillas fijas producen ejercicios y una lista priorizada de estudio. Ninguna respuesta ni habilidad se aprueba automáticamente.

Cada elemento conserva su procedencia: oferta, hecho aprobado, nota de la persona, investigación pública elegida por ella, plantilla fija o sugerencia generada por el asistente. La aplicación no rastrea empresas ni afirma que una pregunta de práctica aparecerá en una entrevista.

Codex es opcional y se autoriza por solicitud. Antes de enviar, la persona ve el contenido exacto y confirma ese envío. Solo se comparten la oferta seleccionada, el CV enviado seleccionado, los hechos aprobados pertinentes, la etapa y la investigación o las notas que la persona elija. Nunca se envían el perfil completo, otras candidaturas, hechos rechazados o sugeridos ni material privado de evaluaciones. La respuesta se etiqueta como práctica generada y solo se guarda si la persona la acepta. Sin Codex, el plan básico sigue funcionando.

El simulacro de texto hace una pregunta cada vez, espera la respuesta y profundiza cuando falta evidencia. Usa una rúbrica explícita de corrección, especificidad, evidencia, estructura y compensaciones. No inventa historias STAR ni presenta una respuesta incorrecta como correcta. Las sesiones son para prepararse: no dan ayuda durante entrevistas o evaluaciones, no acceden a sus sistemas ni usan material filtrado. Voz y grabación requieren otra decisión. No se infieren personalidad ni aptitud por acento, emoción o forma de hablar.

Los planes y sesiones pertenecen a una candidatura y espacio de trabajo. Guardan referencias y hashes de la evidencia elegida, además del contenido aceptado de la sesión; no duplican el perfil completo ni los archivos del CV. Al abrir un plan se detecta si la evidencia quedó obsoleta. La persona puede borrar planes y sesiones. Exportación, copias cifradas, restauración y borrado del espacio deben incluirlos. Completar un ejercicio no modifica hechos aprobados; cualquier cambio sigue el flujo de revisión de hechos existente.

Si se acepta esta propuesta, el trabajo se separa en modelo y ciclo de vida; plan sin IA; sugerencias de Codex con consentimiento; simulacro textual y rúbrica; interfaz bilingüe accesible; y pruebas con datos ficticios. No se empieza la implementación ni se crea una migración antes de aceptar el alcance y el uso de datos.
