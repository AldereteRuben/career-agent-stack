'use client';

import type { Locale } from './locale';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type { Locale } from './locale';
type Translator = (value: string, values?: Record<string, string | number>) => string;
type LocaleContextValue = { locale: Locale; setLocale: (locale: Locale) => void; t: Translator };

const en: Record<string, string> = {
  'Tú decides cuándo compartir datos.': 'You decide when to share data.',
  'Puedes preparar formularios de Lever desde Candidaturas; el envío es manual.': 'Prepare Lever forms from Applications; submission is manual.',
  'Lever permite autocompletar datos de contacto con autorización. Revisa la misma ventana y toma el control para adjuntar y enviar tú. No hay envío automático, IA ni acceso al correo.': 'Lever contact fields can be filled with your permission. Review the same window and take control to attach and submit yourself. There is no automatic submission, AI or email access.',

  'Abriendo tu espacio privado…': 'Opening your private workspace…',
  'A TU ALCANCE': 'WITHIN REACH', 'ACTUALIZADOS RECIENTEMENTE': 'RECENTLY UPDATED', 'AHORA MISMO': 'RIGHT NOW', 'APROBADA': 'APPROVED',
  'Ashby': 'Ashby', 'Confirma que': 'Confirm that', 'Más dirección.': 'More direction.', 'Pégalo desde data/setup-token': 'Paste it from data/setup-token',
  'Tipo de evidencia': 'Evidence type', 'career': 'career', 'careers.example.com': 'careers.example.com', 'current_employment': 'current_employment',
  'data/setup-token': 'data/setup-token', 'Token, site o job-board name': 'Board name from the job board link',
  'Cambiar idioma': 'Change language', 'Saltar al contenido principal': 'Skip to main content',
  'Abrir enlace oficial': 'Open official link', 'Abrir menú': 'Open menu', 'Abrir seguimiento': 'Open application tracker',
  'Actividad': 'Activity', 'Afirmación concreta': 'Specific statement', 'Aplicada (declarada por mí)': 'Applied (self-reported)',
  'Aprobar': 'Approve', 'Aprobar respuesta': 'Approve answer',
  'Aprobar un hecho significa que lo atestiguas. Revisa fechas, números, títulos y credenciales.': 'Approving a fact means you attest that it is true. Check dates, numbers, titles, and credentials.',
  'Aquí solo hay vacantes con origen': 'Only sourced jobs appear here', 'Asociación': 'Company association', 'AÚN NO DISPONIBLE': 'NOT AVAILABLE YET',
  'Añadir como borrador': 'Add as draft', 'Añadir la primera': 'Add your first job', 'Añadir nota': 'Add note', 'Añadir nota al historial': 'Add a note to the history',
  'Añadir tablero': 'Add job board', 'Aún no existe autofill ni envío de candidaturas en esta versión.': 'Autofill and application submission are not available in this version.',
  'Aún no hay documentos': 'No documents yet', 'Aún no hay hechos': 'No career facts yet', 'Borrador': 'Draft', 'Buscar': 'Search', 'Buscar por puesto…': 'Search by job title…', 'Buscar vacantes': 'Search jobs',
  'CANDIDATURAS ACTIVAS': 'ACTIVE APPLICATIONS', 'COBERTURA EXPLÍCITA': 'EXPLICIT SOURCES', 'CON CALMA, CON INTENCIÓN': 'CALM, INTENTIONAL SEARCH',
  'CONTROL Y TRANSPARENCIA': 'CONTROL AND TRANSPARENCY', 'Cada línea tiene una historia.': 'Every line has a story.', 'Cada paso queda anotado.': 'Keep track of every step.',
  'Cancelada': 'Cancelled', 'Career Stack guarda tu búsqueda de empleo en este equipo. Para continuar, utiliza el token de configuración local.': 'Career Stack keeps your job search on this device. To continue, enter your local setup token.',
  'Cerrar menú': 'Close menu', 'Clave del tablero': 'Job board link', 'Clave exacta': 'Exact question key', 'Cobertura de evidencia': 'Evidence coverage', 'Completar mi perfil': 'Complete my profile',
  'Configurar fuentes': 'Set up job sources', 'Confirmación basada en tu declaración. No se verificó con la empresa.': 'This confirmation is based on your statement. It was not verified with the employer.',
  'Confirmar revisión y habilitar lectura': 'Confirm review and enable read-only access',
  'Conoce qué está disponible, qué permanece en tu equipo y qué aún no hace esta versión.': 'See what is available, what stays on this device, and what this version cannot do yet.',
  'Construir borrador': 'Build a draft', 'Contexto de la pregunta': 'Question context', 'Continuar con mi perfil': 'Continue with my profile', 'Correo': 'Email',
  'Crea un borrador desde hechos aprobados. Léelo completo y aprueba esta versión solo cuando te represente.': 'Create a draft from facts you approved. Read it in full and approve this version only if it represents you.',
  'Crear primer registro': 'Create your first record', 'Crear seguimiento': 'Track this application', 'Código ISO de dos letras.': 'Two-letter ISO country code.', 'Cómo cuidamos tus datos': 'How we protect your data',
  'Cómo quieres que aparezca': 'How your name should appear', 'DESACTIVADO': 'OFF', 'DESCUBRIR CON CRITERIO': 'DISCOVER WITH INTENTION', 'DISPONIBLE': 'AVAILABLE',
  'DOCUMENTOS CON ORIGEN': 'DOCUMENTS WITH SOURCES', 'Datos y preferencias': 'Personal details and preferences', 'Desactivar': 'Turn off', 'Descargar PDF': 'Download PDF', 'Descargar exportación': 'Download export',
  'Descartar': 'Discard', 'Descripción (opcional)': 'Description (optional)', 'Descripción guardada': 'Saved description', 'Descubrimiento de solo lectura.': 'Read-only job discovery.',
  'Dominio oficial de empleo': 'Official careers website', 'EL PUESTO': 'THE JOB', 'ENCAJE BASADO EN EVIDENCIA': 'EVIDENCE-BASED MATCH', 'ENVÍOS EXTERNOS': 'EXTERNAL SUBMISSIONS', 'ES': 'Spain',
  'ESPACIO PERSONAL': 'PERSONAL WORKSPACE', 'ESTADO REAL DEL PRODUCTO': 'WHAT THIS VERSION REALLY DOES', 'Ej.: el enlace al tablero aparece en la página oficial de empleo.': 'For example: the job board is linked from the company careers page.',
  'El contenido se trata como texto no confiable; no se ejecuta ni se envía a un modelo.': 'This content is treated as untrusted text. It is not executed or sent to an AI model.',
  'El encaje mide cobertura de hechos aprobados; no predice una contratación ni representa un resultado ATS.': 'The match score measures coverage of approved facts. It does not predict a hiring outcome or represent an ATS result.',
  'El enlace se abrirá solo cuando tú lo elijas. Career Stack no carga páginas de empleo al importar una URL.': 'The link opens only when you choose to open it. Career Stack does not load job pages when you add a URL.',
  'El envío de candidaturas no está disponible en v0.3.': 'Application submission is not available in v0.3.', 'El historial también es dato personal.': 'Your activity history is personal data too.',
  'El perfil vive en esta instalación local. No se comparte con empresas.': 'Your profile stays on this local installation. It is not shared with employers.',
  'El token se guarda fuera de la URL y se consume una sola vez. La sesión dura 14 días.': 'The token is never placed in the URL and can only be used once. Your session lasts 14 days.',
  'Elegibilidad': 'Eligibility', 'Elige una candidatura': 'Select an application',
  'Empieza con un perfil honesto y unas pocas fuentes que te importen. El resto se construye paso a paso.': 'Start with an honest profile and a few job sources that matter to you. Build from there, one step at a time.',
  'Empieza desde la página oficial de empleo.': 'Start from the company careers page.', 'Empieza por aquí.': 'Start here.', 'Empresa': 'Company',
  'Escribe solo lo que quieras guardar': 'Write only what you want to save',
  'Esta fuente no entregó descripción. No estimamos requisitos que no aparecen en los datos disponibles.': 'This source did not provide a description. We do not guess requirements that are not in the available data.',
  'Esta versión no implementa usuarios remotos ni sincronización en nube. No compartas el puerto local con tu red.': 'This version does not support remote users or cloud sync. Do not expose the local port to your network.',
  'Estado del registro': 'Record status', 'Etapa de selección': 'Hiring stage', 'Etiquetas': 'Tags', 'Europa · Madrid': 'Europe · Madrid',
  'Experiencia laboral': 'Work experience', 'Experiencia técnica': 'Technical experience', 'Explorar oportunidades': 'Explore jobs',
  'Exporta perfil, hechos, respuestas, vacantes, fuentes y candidaturas. Las fuentes quedan desactivadas al exportar. Los PDF generados se adjuntan al archivo JSON.': 'Export your profile, career facts, answers, jobs, sources, and applications. Job sources are disabled in the export. Generated PDFs are included in the JSON file.',
  'FUENTES APROBADAS': 'APPROVED SOURCES', 'Formación': 'Education', 'Fuente': 'Source', 'Fuentes de empleo': 'Job sources', 'Fuentes de solo lectura': 'Read-only job sources', 'Gestionar fuentes': 'Manage sources',
  'Greenhouse': 'Greenhouse', 'Guarda lo que sabes, revisa cada afirmación y conserva la historia de tus cambios.': 'Save what you know, review every claim, and keep a history of your changes.',
  'Guardar nueva revisión': 'Save new revision', 'Guardar para revisión': 'Save for review', 'Guardar vacante a mano': 'Add a job manually', 'Hecho para pensar tu siguiente paso.': 'Made to help you choose your next step.',
  'Hechos aprobados': 'Approved facts', 'Hechos de carrera': 'Career facts', 'INSTALACIÓN LOCAL': 'LOCAL INSTALLATION',
  'Incluye datos personales. Guarda la copia en una ubicación privada.': 'This export contains personal information. Store it somewhere private.', 'Ir a la fuente original': 'Visit the original source',
  'Jurisdicción': 'Country or region', 'LA BASE DE TODO': 'YOUR FOUNDATION', 'LECTURA BASADA EN EVIDENCIA': 'EVIDENCE-BASED MATCH',
  'La URL se guarda como referencia; no visitamos la página.': 'We save the URL as a reference; we do not visit the page.',
  'La copia de seguridad operativa y restauración aislada aún no están implementadas. No guardes aquí tu única copia de datos importantes.': 'Automated backups and isolated restore are not implemented yet. Do not keep your only copy of important data here.',
  'La encuentras en la URL pública del tablero.': 'You can find this in the public job board link.', 'La identidad importa': 'Verify the company', 'La privacidad se puede ver.': 'Privacy you can verify.',
  'La respuesta empieza sin aprobar. Revisa su significado y su vigencia antes de aprobarla.': 'Your answer starts as a draft. Check that it is accurate and current before approving it.',
  'Tus datos se guardan en este equipo. El acceso inicial utiliza un código de un solo uso y tu sesión permanece privada.': 'Your data is stored on this device. First sign-in uses a one-time code and your session stays private.',
  'Las URL de LinkedIn se guardan solo como texto y no se abren.': 'LinkedIn URLs are saved as text only and are never opened.',
  'Las integraciones consultan solo tableros concretos. Una fuente empieza sin verificar y requiere tu revisión.': 'Integrations read only specific job boards. Each source starts unverified and needs your review.',
  'Lever': 'Lever', 'Lo que apruebas, cuenta.': 'Only facts you approve are used.', 'Lo que puedes hacer': 'What you can do', 'Lo que sabemos': 'What we know',
  'Local y privado': 'Local and private', 'Logro': 'Achievement', 'Los borradores no se usarán en documentos hasta que los apruebes.': 'Draft facts are not used in documents until you approve them.',
  'Los documentos solo toman hechos aprobados en la revisión actual de tu perfil.': 'Documents only use facts you approved in your current profile revision.',
  'Los estados de autofill y envío están desactivados en v0.3.': 'Autofill and submission states are disabled in v0.3.',
  'Los registros de eventos y las exportaciones pueden contener notas sensibles. Elimina las copias antiguas cuando ya no las necesites.': 'Activity records and exports may contain sensitive notes. Delete old copies when you no longer need them.',
  'Menos ruido.': 'Less noise.', 'Modalidades': 'Work preferences', 'Navegación principal': 'Main navigation',
  'No hace falta aplicar a todo. Hace falta poder explicar por qué algo merece tu tiempo.': 'You do not need to apply to everything. Focus on the jobs you can explain and stand behind.',
  'No hay IA, correo, navegador automatizado ni envío externo en v0.3. El acceso a fuentes públicas es de solo lectura y cada tablero requiere tu revisión.': 'There is no AI, email, browser automation, or external submission in v0.3. Public job sources are read-only and require your review.',
  'No hay autofill ni carga a empleadores en este release.': 'Autofill and employer uploads are not available in this release.', 'No hay hechos aprobados': 'No approved facts yet',
  'No inferimos permisos laborales, expectativas salariales ni datos sensibles.': 'We do not guess work authorization, salary expectations, or sensitive information.',
  'Nombre': 'Name', 'Nombre de la empresa': 'Company name', 'Nombre de la versión': 'Version name', 'Nota de revisión': 'Review note',
  'Opcional, separadas por comas.': 'Optional; separate with commas.', 'Oportunidades recientes': 'Recent opportunities', 'Orientar a una vacante (opcional)': 'Tailor to a job (optional)',
  'PDF · TEXTO': 'PDF · TEXT', 'PENDIENTES': 'PENDING', 'PERFIL BASE': 'BASE PROFILE', 'País de trabajo': 'Work country',
  'Pega aquí el texto del anuncio para explicar el encaje.': 'Paste the job description here to explain the match.', 'Permiso de lectura': 'Read-only access',
  'Preferencias, no una garantía de elegibilidad.': 'Preferences only; this does not guarantee eligibility.', 'Preparando': 'Preparing', 'Privacidad y control': 'Privacy and controls',
  'Privado por defecto': 'Private by default', 'Proveedor': 'Job board', 'Proyecto': 'Project', 'Próximo paso, preguntas o contexto…': 'Next step, questions, or context…',
  'Publicado por la fuente': 'Posted by source', 'Puesto': 'Job title', 'Puestos que buscas': 'Job titles you are looking for', 'Página de empleo oficial': 'Official careers page',
  'Qué hiciste, con qué herramientas y en qué contexto…': 'What you did, which tools you used, and in what context…', 'REGISTRO DE FUENTES': 'JOB SOURCES', 'REGISTROS': 'RECORDS', 'RELEASE': 'RELEASE', 'REVISIÓN': 'REVISION',
  'Recuperación pendiente': 'Backup and recovery', 'Registrar una candidatura': 'Add an application', 'Región API': 'Region', 'Renderizado local y limpio': 'Locally generated, clean PDF',
  'Respuestas que dependen de ti': 'Answers only you can provide', 'Revisa tus datos y guarda solo lo que puedas sostener con tu experiencia.': 'Review your details and save only what your experience supports.',
  'Revisar perfil': 'Review profile', 'Revisión pendiente': 'Needs review', 'SDET, QA Automation Engineer': 'SDET, QA Automation Engineer', 'SEGUIMIENTO, SIN PRESIÓN': 'APPLICATION TRACKING, AT YOUR PACE',
  'SELECCIONADOS': 'SELECTED', 'SHA-256 ·': 'SHA-256 ·', 'SIN ENVÍOS': 'NO SUBMISSIONS', 'SIN RASTREO': 'NO TRACKING', 'Salir': 'Sign out',
  'Se guardará como una declaración tuya, no como verificación externa.': 'This will be saved as your statement, not as external verification.',
  'Selecciona solo lo que quieras incluir.': 'Select only the facts you want to include.', 'Selección estricta: no reescribimos ni añadimos logros.': 'Strict selection: we do not rewrite or add achievements.',
  'Separa los puestos con comas.': 'Separate job titles with commas.', 'Sesión local': 'Local session', 'Si aparece en el anuncio': 'If listed in the job description',
  'Sin fuentes configuradas': 'No job sources set up', 'Sin sorpresas.': 'No surprises.', 'Solo aparecen las fuentes que configuras o las oportunidades que guardas tú. Nunca buscamos en todo internet.': 'Only sources you set up and jobs you save appear here. We never search the entire internet.',
  'Solo en este equipo': 'Only on this device', 'Solo guardamos lo que tú escribes; nada se envía a la empresa.': 'We only save what you enter. Nothing is sent to the employer.',
  'Solo para organizar este espacio y preparar borradores.': 'Used only to organize your workspace and prepare drafts.', 'Solo se registra. No se visita automáticamente.': 'Saved as a reference only. It is not opened automatically.',
  'Solo tus fuentes y registros': 'Only your sources and saved jobs', 'T': 'Y', 'TU BÚSQUEDA, A TU RITMO': 'YOUR SEARCH, AT YOUR PACE', 'TU HISTORIAL': 'YOUR HISTORY',
  'Todavía no hay candidaturas': 'No applications yet', 'Token de configuración': 'Setup token', 'Tu búsqueda vive aquí.': 'Your job search stays here.',
  'Tu copia de trabajo': 'Your working copy', 'Tu espacio': 'Your workspace', 'Tu evidencia': 'Your evidence', 'Tu lista aún está en blanco': 'Your list is empty', 'Tu panorama': 'Your overview',
  'Tu perfil, con evidencia.': 'Your profile, backed by evidence.', 'Tu proceso': 'Your progress', 'Tu respuesta': 'Your answer', 'Tu siguiente paso,': 'Your next step,',
  'Tus datos no salen de aquí.': 'Your data stays on this device.', 'Tus documentos': 'Your documents', 'Tus hechos nunca se aprueban solos.': 'Your facts are never approved automatically.', 'Tus tableros': 'Your job boards',
  'Tú eliges dónde buscar.': 'Choose where to search.', 'UE (Lever)': 'EU (Lever)', 'UN ESPACIO SOLO TUYO': 'A WORKSPACE THAT IS YOURS', 'UNA COSA A LA VEZ': 'ONE STEP AT A TIME',
  'URL de referencia': 'Reference URL', 'URL oficial de documentación revisada': 'Official documentation you reviewed', 'URL oficial de la vacante': 'Official job URL', 'Ubicación': 'Location',
  'Un buen punto de partida': 'A good place to start', 'Un lugar tranquilo para buscar mejor, contar lo que sabes y llevar el pulso de cada candidatura.': 'A calm place to search with intention, show what you know, and track each application.',
  'Un registro claro de lo que ya hiciste y lo que viene después.': 'A clear record of what you have done and what comes next.', 'Un resumen, sin prisa': 'A calm overview',
  'Un tablero público no autoriza a rellenar ni enviar formularios. Estas integraciones nunca abren la web del empleador.': 'A public job board does not grant permission to fill in or submit forms. These integrations never open the employer website.',
  'Una búsqueda sostenible también cuenta.': 'A sustainable job search matters too.', 'Una clave parecida al nombre de la empresa no demuestra quién opera el tablero. La asociación se confirma contigo.': 'A job board name that resembles a company name does not prove who operates it. You confirm the association.',
  'Una columna, texto seleccionable, sin imágenes remotas ni scripts. Comprueba el orden de lectura y las instrucciones de carga de cada empleador.': 'One column, selectable text, no remote images or scripts. Check the reading order and each employer’s upload instructions.',
  'Una instalación, un espacio.': 'One installation, one workspace.', 'VACANTES GUARDADAS': 'SAVED JOBS', 'VERSIONES INMUTABLES': 'LOCKED VERSIONS', 'Vacantes que merecen una mirada.': 'Jobs worth a closer look.',
  'Ver detalles': 'View details', 'Ver todas': 'View all', 'Versión base': 'General version', 'Vista el': 'Viewed on',
  'Ya envié esta candidatura y quiero registrarla como confirmada.': 'I have already applied and want to record it as confirmed.', 'Ya lo revisé': 'I have reviewed it', 'c': 'c',
  'con intención.': 'with intention.', 'configurados': 'set up', 'encaje': 'match', 'hechos': 'facts', 'https://...': 'https://…', 'java, api-testing': 'java, api-testing',
  'legally_authorized_to_work': 'legally_authorized_to_work', 'nombre@ejemplo.com': 'name@example.com', 'pertenece a': 'belongs to', 'pnpm run reset:session': 'pnpm run reset:session',
  'remote, hybrid': 'remote, hybrid', 'stack': 'stack', 'tu espacio de carrera': 'your career space', 'v0.3': 'v0.3', 'y lee el token nuevo en': 'and read the new token from',
  'y revisa el alcance GET público de': 'and review the public read access for', 'Última lectura': 'Last checked', 'Última observación': 'Last seen', 'Última revisión': 'Last reviewed',
  '← Volver a vacantes': '← Back to jobs', '↻ Las lecturas manuales tienen una pausa mínima de seis horas. Las lecturas incompletas no cierran vacantes.': 'Manual checks have a minimum six-hour cooldown. Incomplete checks do not close jobs.',
  'JOB SOURCES': 'JOB SOURCES', 'Choose where to search.': 'Choose where to search.',
  'Add the company careers page and its public job board. We only read public job listings; we never fill in or submit applications.': 'Add the company careers page and its public job board. We only read public job listings; we never fill in or submit applications.',
  'Read-only job search': 'Read-only job search', 'Adding a source never gives this app permission to fill in or submit forms.': 'Adding a source never gives this app permission to fill in or submit forms.', 'NO SUBMISSIONS': 'NO SUBMISSIONS',
  'YOUR SOURCES': 'YOUR SOURCES', 'Job sources': 'Job sources', '{count} set up': '{count} set up', 'EU': 'EU',
  'READING ON': 'READING ON', 'NEEDS REVIEW': 'NEEDS REVIEW', 'Company link': 'Company link', 'Confirmed by you': 'Confirmed by you', 'Not checked': 'Not checked',
  'Public job listings': 'Public job listings', 'Read-only access approved': 'Read-only access approved', 'Not approved': 'Not approved', 'Last review': 'Last review', 'Not reviewed': 'Not reviewed', 'Last checked': 'Last checked',
  'Company careers page:': 'Company careers page:', 'I confirmed this job board is linked from the company careers page.': 'I confirmed this job board is linked from the company careers page.',
  'I understand this app only reads public job listings and will not submit applications.': 'I understand this app only reads public job listings and will not submit applications.',
  'Read the provider’s public job board documentation': 'Read the provider’s public job board documentation', 'Saving…': 'Saving…', 'Approve read-only job search': 'Approve read-only job search',
  'Checking…': 'Checking…', 'Find new jobs': 'Find new jobs', 'Turn off': 'Turn off', 'No job sources yet': 'No job sources yet',
  'Add a company careers page and a supported job board link. We will never activate it before you review it.': 'Add a company careers page and a supported job board link. We will never activate it before you review it.',
  'You can check a source once every six hours. An incomplete check will not close a job.': 'You can check a source once every six hours. An incomplete check will not close a job.',
  'Add a job source': 'Add a job source', 'No technical keys or regions needed. Paste the links you already use.': 'No technical keys or regions needed. Paste the links you already use.',
  'Set up a source': 'Set up a source', 'Company name': 'Company name', 'Example: Northwind': 'Example: Northwind', 'Company careers page': 'Company careers page',
  'The page where the company lists its jobs.': 'The page where the company lists its jobs.', 'Job board link': 'Job board link',
  'Open a job from the careers page, then copy the address from your browser.': 'Open a job from the careers page, then copy the address from your browser.',
  '{provider} detected · {region}': '{provider} detected · {region}', 'We could not recognize that job board link. Supported links are Greenhouse, Lever, and Ashby.': 'We could not recognize that job board link. Supported links are Greenhouse, Lever, and Ashby.',
  'Where can I find these links?': 'Where can I find these links?', 'Open the company’s official careers page. Copy its address, open a listed job, and copy that address too.': 'Open the company’s official careers page. Copy its address, open a listed job, and copy that address too.',
  'Add source for review': 'Add source for review', 'Cancel': 'Cancel', 'You stay in control': 'You stay in control',
  'We only check the public job listings on the board link you provide. You confirm it belongs to the company before we search it.': 'We only check the public job listings on the board link you provide. You confirm it belongs to the company before we search it.',
  'Add a supported job board link and the company careers page.': 'Add a supported job board link and the company careers page.',
  'Source added. Review the company link before turning on job search.': 'Source added. Review the company link before turning on job search.',
  'Source approved for read-only job search.': '{company} is approved for read-only job search.', 'Job search finished: {added} new and {updated} updated.': 'Job search finished: {added} new and {updated} updated.',
  'Job source turned off.': 'Job source turned off.',
  'What is the application asking?': 'What is the application asking?', 'Example: Are you authorized to work in this country?': 'Example: Are you authorized to work in this country?',
  'Country or region': 'Country or region', 'Choose a country…': 'Choose a country…', 'Spain': 'Spain', 'United States': 'United States', 'United Kingdom': 'United Kingdom',
  'Canada': 'Canada', 'Germany': 'Germany', 'France': 'France', 'Netherlands': 'Netherlands', 'Ireland': 'Ireland', 'Australia': 'Australia', 'Your answer': 'Your answer',
  'Write only what you want to save': 'Write only what you want to save', 'Your answer starts as a draft. Check that it is accurate and current before approving it.': 'Your answer starts as a draft. Check that it is accurate and current before approving it.',
  'Save for review': 'Save for review', 'No answer': 'No answer',
  'Start with an achievement or skill you can describe clearly.': 'Start with an achievement or skill you can describe clearly.',
  'Searching {count} approved sources': 'Searching {count} approved sources', 'Searching 1 approved source': 'Searching 1 approved source',
  'Preparing source coverage…': 'Preparing source coverage…', 'Location to be confirmed': 'Location to be confirmed', 'Refresh an approved source or add a job manually.': 'Refresh an approved source or add a job manually.',
  'Set up a job source or add a job you already have in mind.': 'Set up a job source or add a job you already have in mind.',
  'Read-only job source approved.': 'Read-only job source approved.',
  'ACTIVAS': 'ACTIVE', 'POR CONFIGURAR': 'TO SET UP', 'AL DÍA': 'UP TO DATE', 'FALTA CONTEXTO': 'NEEDS CONTEXT', 'SEGUIMIENTO': 'TRACKING',
  'Tienes hechos pendientes de aprobar.': 'You have facts waiting for approval.', 'Cada logro empieza por un hecho aprobado.': 'Every achievement starts with a fact you approve.',
  'Tus candidaturas y próximos pasos, en un solo lugar.': 'Your applications and next steps, in one place.', 'Cuando empieces a aplicar, aquí verás el recorrido.': 'Your application progress will appear here when you start applying.',
  'Por completar': 'To complete', 'En revisión': 'In review',
  'Actualiza una fuente aprobada o añade una vacante a mano.': 'Refresh an approved source or add a job manually.', 'Añade una fuente de empleo o importa una vacante que ya tengas en mente.': 'Set up a job source or add a job you already have in mind.',
  'Añadir primera vacante': 'Add your first job', 'Revisar fuentes': 'Review sources', 'Buscar por puesto': 'Search by job title', 'Nuevas': 'New', 'Guardada': 'Saved',
  'Perfil guardado en una nueva revisión.': 'Profile saved as a new revision.', 'Hecho añadido como pendiente de aprobación.': 'Fact added and waiting for your approval.',
  'Respuesta guardada para que la revises.': 'Answer saved for your review.', 'Hecho aprobado por ti.': 'Fact approved by you.', 'Hecho descartado.': 'Fact discarded.', 'Respuesta aprobada por ti.': 'Answer approved by you.',
  'Vacante guardada y valorada con hechos aprobados.': 'Job saved and assessed using approved facts.', 'Lista actualizada.': 'Saved jobs list updated.',
  'Seguimiento actualizado.': 'Application tracker updated.', 'Nota añadida al historial.': 'Note added to the history.',
  'Borrador PDF generado. Descárgalo y revísalo antes de aprobarlo.': 'PDF draft generated. Download and review it before approving.',
  'Documento aprobado por ti. Esta versión queda vinculada a los hechos seleccionados.': 'Document approved by you. This version is linked to the facts you selected.',
  'APPLICATION_CREATED': 'Application created', 'MANUAL_APPLICATION_RECORDED': 'Application confirmed by you', 'APPLICATION_STATE_CHANGED': 'Application status changed', 'RECRUITMENT_STAGE_CHANGED': 'Hiring stage updated', 'USER_NOTE': 'Note added',
  'Registro manual': 'Added manually', 'Confirmación declarada por ti': 'Confirmation reported by you', 'Cambio guardado': 'Change saved', 'Inicio': 'Start', 'Sin respuesta': 'No response',
  'Añadida el': 'Added on', 'Sin datos suficientes para puntuar': 'Not enough information to score',
  'Lista actualizada': 'Saved jobs list updated', 'Confirmación basada en tu declaración': 'Confirmed based on your statement',
  'Encuentra empleo': 'Find jobs', 'Job search started': 'Job search started',
  'achievement': 'Achievement', 'experience': 'Work experience', 'skill evidence': 'Technical experience', 'skill_evidence': 'Technical experience', 'project': 'Project', 'education': 'Education',
  'UNKNOWN': 'Unknown', 'APPROVED_FOR_SCOPE': 'Approved for this job board', 'BLOCKED': 'Blocked', 'global': 'Global', 'eu': 'EU',
  'PASS': 'Compatible', 'FAIL': 'Does not match', 'NEEDS_REVIEW': 'Needs review',
  'RECRUITER_CONTACT': 'Recruiter contact', 'ASSESSMENT': 'Assessment', 'INTERVIEW': 'Interview', 'FINAL_INTERVIEW': 'Final interview', 'OFFER': 'Offer', 'REJECTED': 'Rejected', 'WITHDRAWN': 'Withdrawn', 'HIRED': 'Hired',
  'DRAFT': 'Draft', 'PREPARING': 'Preparing', 'REVIEW_REQUIRED': 'Needs review', 'CONFIRMED': 'Applied', 'CANCELLED': 'Cancelled', 'NO_RESPONSE': 'No response',
};

const es: Record<string, string> = {
  'JOB SOURCES': 'FUENTES DE EMPLEO', 'Choose where to search.': 'Elige dónde buscar.',
  'Add the company careers page and its public job board. We only read public job listings; we never fill in or submit applications.': 'Añade la página de empleo de la empresa y su tablero público. Solo leemos vacantes; nunca rellenamos ni enviamos candidaturas.',
  'Read-only job search': 'Búsqueda de solo lectura', 'Adding a source never gives this app permission to fill in or submit forms.': 'Añadir una fuente nunca da permiso a esta app para rellenar o enviar formularios.', 'NO SUBMISSIONS': 'SIN ENVÍOS',
  'YOUR SOURCES': 'TUS FUENTES', 'Job sources': 'Fuentes de empleo', '{count} set up': '{count} configuradas',
  'READING ON': 'LECTURA ACTIVA', 'NEEDS REVIEW': 'PENDIENTE DE REVISIÓN', 'Company link': 'Enlace de la empresa', 'Confirmed by you': 'Confirmado por ti', 'Not checked': 'Sin comprobar',
  'Public job listings': 'Vacantes públicas', 'Read-only access approved': 'Lectura aprobada', 'Not approved': 'Sin aprobar', 'Last review': 'Última revisión', 'Not reviewed': 'Pendiente', 'Last checked': 'Última lectura',
  'Company careers page:': 'Página de empleo de la empresa:', 'I confirmed this job board is linked from the company careers page.': 'He confirmado que este tablero aparece enlazado desde la página de empleo de la empresa.',
  'I understand this app only reads public job listings and will not submit applications.': 'Entiendo que esta app solo lee vacantes públicas y no enviará candidaturas.',
  'Read the provider’s public job board documentation': 'Leer la documentación pública del proveedor', 'Saving…': 'Guardando…', 'Approve read-only job search': 'Aprobar búsqueda de solo lectura',
  'Checking…': 'Consultando…', 'Find new jobs': 'Buscar vacantes nuevas', 'Turn off': 'Desactivar', 'No job sources yet': 'Aún no hay fuentes',
  'Add a company careers page and a supported job board link. We will never activate it before you review it.': 'Añade la página de empleo de la empresa y un enlace compatible. No activaremos la fuente antes de que la revises.',
  'You can check a source once every six hours. An incomplete check will not close a job.': 'Puedes consultar cada fuente una vez cada seis horas. Una lectura incompleta no cerrará ninguna vacante.',
  'Add a job source': 'Añadir una fuente de empleo', 'No technical keys or regions needed. Paste the links you already use.': 'No necesitas claves ni regiones técnicas. Pega los enlaces que ya utilizas.',
  'Set up a source': 'Configurar una fuente', 'Company name': 'Nombre de la empresa', 'Example: Northwind': 'Ejemplo: Northwind', 'Company careers page': 'Página de empleo de la empresa',
  'The page where the company lists its jobs.': 'La página donde la empresa publica sus vacantes.', 'Job board link': 'Enlace al tablero de empleo',
  'Open a job from the careers page, then copy the address from your browser.': 'Abre una vacante desde la página de empleo y copia la dirección del navegador.',
  '{provider} detected · {region}': '{provider} detectado · {region}', 'We could not recognize that job board link. Supported links are Greenhouse, Lever, and Ashby.': 'No reconocemos ese enlace. Admitimos tableros de Greenhouse, Lever y Ashby.',
  'Where can I find these links?': '¿Dónde encuentro estos enlaces?', 'Open the company’s official careers page. Copy its address, open a listed job, and copy that address too.': 'Abre la página oficial de empleo de la empresa y copia su dirección. Abre una vacante y copia también ese enlace.',
  'Add source for review': 'Añadir fuente para revisar', 'Cancel': 'Cancelar', 'You stay in control': 'Tú mantienes el control',
  'We only check the public job listings on the board link you provide. You confirm it belongs to the company before we search it.': 'Solo consultamos las vacantes públicas del tablero que indiques. Tú confirmas que pertenece a la empresa antes de activar la búsqueda.',
  'Add a supported job board link and the company careers page.': 'Añade un enlace compatible y la página de empleo de la empresa.',
  'Source added. Review the company link before turning on job search.': 'Fuente añadida. Revisa el enlace de la empresa antes de activar la búsqueda.',
  'Source approved for read-only job search.': 'Fuente aprobada para buscar vacantes en modo de solo lectura.', 'Job search finished: {added} new and {updated} updated.': 'Búsqueda terminada: {added} nuevas y {updated} actualizadas.',
  'Job source turned off.': 'Fuente desactivada.',
  'What is the application asking?': '¿Qué te pregunta la solicitud?', 'Example: Are you authorized to work in this country?': 'Ejemplo: ¿Tienes permiso para trabajar en este país?',
  'Country or region': 'País o región', 'Choose a country…': 'Elige un país…', 'Spain': 'España', 'United States': 'Estados Unidos', 'United Kingdom': 'Reino Unido',
  'Canada': 'Canadá', 'Germany': 'Alemania', 'France': 'Francia', 'Netherlands': 'Países Bajos', 'Ireland': 'Irlanda', 'Australia': 'Australia', 'Your answer': 'Tu respuesta',
  'Write only what you want to save': 'Escribe solo lo que quieras guardar', 'Your answer starts as a draft. Check that it is accurate and current before approving it.': 'La respuesta empieza como borrador. Comprueba que sea correcta y esté vigente antes de aprobarla.',
  'Save for review': 'Guardar para revisar', 'No answer': 'Sin respuesta', 'Start with an achievement or skill you can describe clearly.': 'Empieza con un logro o una habilidad que puedas describir con claridad.',
  'Searching {count} approved sources': 'Buscando en {count} fuentes aprobadas', 'Searching 1 approved source': 'Buscando en 1 fuente aprobada',
  'Preparing source coverage…': 'Preparando las fuentes…', 'Location to be confirmed': 'Ubicación por confirmar', 'Refresh an approved source or add a job manually.': 'Actualiza una fuente aprobada o añade una vacante a mano.',
  'Set up a job source or add a job you already have in mind.': 'Configura una fuente o añade una vacante que ya tengas en mente.',
  'ACTIVE': 'ACTIVAS', 'TO SET UP': 'POR CONFIGURAR', 'UP TO DATE': 'AL DÍA', 'NEEDS CONTEXT': 'FALTA CONTEXTO', 'TRACKING': 'SEGUIMIENTO',
  'You have facts waiting for approval.': 'Tienes hechos pendientes de aprobar.', 'Every achievement starts with a fact you approve.': 'Cada logro empieza por un hecho que apruebas.',
  'Your applications and next steps, in one place.': 'Tus candidaturas y próximos pasos, en un solo lugar.', 'Your application progress will appear here when you start applying.': 'Cuando empieces a solicitar empleos, aquí verás el recorrido.',
  'To complete': 'Por completar', 'In review': 'En revisión', 'Your list is empty': 'Tu lista aún está en blanco', 'Add your first job': 'Añadir primera vacante', 'Review sources': 'Revisar fuentes',
  'Profile saved as a new revision.': 'Perfil guardado en una nueva revisión.', 'Fact added and waiting for your approval.': 'Hecho añadido como pendiente de aprobación.', 'Answer saved for your review.': 'Respuesta guardada para que la revises.',
  'Fact approved by you.': 'Hecho aprobado por ti.', 'Fact discarded.': 'Hecho descartado.', 'Answer approved by you.': 'Respuesta aprobada por ti.',
  'Job saved and assessed using approved facts.': 'Vacante guardada y valorada con hechos aprobados.', 'Saved jobs list updated.': 'Lista de vacantes guardadas actualizada.', 'Application tracker updated.': 'Seguimiento actualizado.', 'Note added to the history.': 'Nota añadida al historial.',
  'PDF draft generated. Download and review it before approving.': 'Borrador PDF generado. Descárgalo y revísalo antes de aprobarlo.', 'Document approved by you. This version is linked to the facts you selected.': 'Documento aprobado por ti. Esta versión queda vinculada a los hechos seleccionados.',
  'Application created': 'Candidatura creada', 'Application confirmed by you': 'Candidatura confirmada por ti', 'Application status changed': 'Estado actualizado', 'Hiring stage updated': 'Etapa del proceso actualizada', 'Note added': 'Nota añadida',
  'Added manually': 'Registro manual', 'Confirmation reported by you': 'Confirmación declarada por ti', 'Change saved': 'Cambio guardado', 'Start': 'Inicio', 'No response': 'Sin respuesta',
  'Added on': 'Añadida el', 'Not enough information to score': 'Sin datos suficientes para puntuar', 'Match': 'Encaje',
};


Object.assign(en, {
  'Ha ocurrido un error. Inténtalo de nuevo.': 'Something went wrong. Try again.', '¿Se consumió el token? Desde la carpeta del proyecto, ejecuta': 'Did the token get used? From the project folder, run', 'Selecciona un registro para ver su actividad y actualizar el siguiente paso.': 'Choose an application to see its activity and update the next step.', 'Crea un registro al empezar una solicitud o anota una candidatura que ya enviaste.': 'Create a record when you start an application, or add one you have already submitted.', 'Rev.': 'Rev.', '% de cobertura': '% coverage', 'Ubicación por confirmar': 'Location to be confirmed', '·': '·', '01': '01', '02': '02', '03': '03', 'Resumen': 'Overview', 'Vacantes': 'Jobs', 'Candidaturas': 'Applications', 'Mi perfil': 'My profile', 'Documentos': 'Documents', 'Fuentes': 'Job sources', 'Privacidad': 'Privacy',
  'Cerrar': 'Close', 'Añadir candidatura': 'Add application', 'Candidatura registrada como confirmación declarada por ti.': 'Application recorded as self-reported.', 'Candidatura añadida al seguimiento.': 'Application added to your tracker.',
  'Cerrar formulario': 'Close form', 'Añadir vacante': 'Add a job', 'Guardando…': 'Saving…', 'Guardar y calcular encaje': 'Save and assess match', 'vacante visible': 'job visible', 'vacantes visibles': 'jobs visible',
  'Quitar de la lista': 'Remove from saved jobs', 'Guardar en lista': 'Save job', 'Añade una a mano o registra un tablero de empleo verificado. El encaje se calcula con hechos que hayas aprobado; los datos que faltan se marcan para revisión.': 'Add a job manually or set up a supported job board. Matches use facts you approved; missing information is marked for review.',
  'Generando borrador…': 'Generating draft…', 'Generar PDF local': 'Generate local PDF', 'APROBADO': 'APPROVED', 'PENDIENTE': 'PENDING', 'Aprueba hechos en tu perfil antes de usarlos en un documento.': 'Approve facts in your profile before using them in a document.', 'Cuando apruebes tus primeros hechos, podrás generar una versión para revisar.': 'Once you approve your first facts, you can generate a draft to review.',
  'Lista actualizada.': 'Saved jobs list updated.', 'Guardada': 'Saved', 'Guardar vacante': 'Save job', 'Por confirmar': 'To be confirmed', 'Necesita revisión': 'Needs review',
  'Añadida el': 'Added on', 'Registrar una candidatura': 'Add an application', 'Etapa de selección': 'Hiring stage', 'Estado del registro': 'Application status', 'Candidatura creada': 'Application created', 'Candidatura confirmada por ti': 'Application confirmed by you', 'Estado actualizado': 'Status updated', 'Etapa del proceso actualizada': 'Hiring stage updated', 'Nota añadida': 'Note added',
  'Perfil y hechos aprobados': 'Profile and approved facts', 'Aprobación manual': 'Manual approval', 'Banco de respuestas': 'Answer bank', 'Importación manual': 'Manual job import', 'Descubrimiento por tableros aprobados': 'Approved job board search', 'Encaje explicable': 'Explainable job match', 'Seguimiento de candidaturas': 'Application tracking', 'Borradores PDF revisables': 'Reviewable PDF drafts', 'Copia local y recuperación': 'Local backup and recovery', 'Exportación JSON': 'JSON export', 'Procesamiento con IA': 'AI processing', 'Autorrelleno en navegador': 'Browser autofill', 'Envío a empresas': 'Employer submission', 'Acceso al correo': 'Email access', 'Preparación de entrevistas': 'Interview preparation', 'Alojamiento multiusuario': 'Hosted multi-user accounts',
  'ACTIVOS': 'ACTIVE', 'DESACTIVADOS': 'OFF', 'Exp': 'Rev.', 'Añade una fuente a mano': 'Add a source manually', 'candidaturas': 'applications', 'Registros': 'Records', 'job_application': 'Job application', 'APROBADO POR TI': 'APPROVED BY YOU', 'DESCARTADO': 'DISCARDED', 'Logro': 'Achievement', 'Experiencia técnica': 'Technical experience', 'Experiencia laboral': 'Work experience', 'Formación': 'Education', 'Proyecto': 'Project',
  'Cómo quieres que aparezca': 'How should your name appear?', 'Correo': 'Email', 'ES': 'ES', 'Código ISO de dos letras.': 'Two-letter ISO country code.', 'Guardar nueva revisión': 'Save new revision', 'Etiquetas': 'Tags', 'Descartar': 'Discard', 'APROBADA': 'APPROVED',
});
Object.assign(es, {
  'Close': 'Cerrar', 'Add application': 'Añadir candidatura', 'Application recorded as self-reported.': 'Candidatura registrada como confirmación declarada por ti.', 'Application added to your tracker.': 'Candidatura añadida al seguimiento.',
  'Close form': 'Cerrar formulario', 'Add a job': 'Añadir vacante', 'Saving…': 'Guardando…', 'Save and assess match': 'Guardar y calcular encaje', 'job visible': 'vacante visible', 'jobs visible': 'vacantes visibles',
  'Remove from saved jobs': 'Quitar de la lista', 'Save job': 'Guardar vacante', 'Location to be confirmed': 'Ubicación por confirmar', 'Add a job manually or set up a supported job board. Matches use facts you approved; missing information is marked for review.': 'Añade una a mano o registra un tablero de empleo compatible. El encaje se calcula con hechos aprobados; los datos que faltan se marcan para revisión.',
  'Generating draft…': 'Generando borrador…', 'Generate local PDF': 'Generar PDF local', 'APPROVED': 'APROBADO', 'PENDING': 'PENDIENTE', 'Approve facts in your profile before using them in a document.': 'Aprueba hechos en tu perfil antes de usarlos en un documento.', 'Once you approve your first facts, you can generate a draft to review.': 'Cuando apruebes tus primeros hechos, podrás generar una versión para revisar.',
  'Saved jobs list updated.': 'Lista actualizada.', 'Saved': 'Guardada', 'To be confirmed': 'Por confirmar', 'Needs review': 'Necesita revisión', 'Added on': 'Añadida el',
  'Hiring stage': 'Etapa de selección', 'Application status': 'Estado del registro', 'Application created': 'Candidatura creada', 'Application confirmed by you': 'Candidatura confirmada por ti', 'Status updated': 'Estado actualizado', 'Hiring stage updated': 'Etapa del proceso actualizada', 'Note added': 'Nota añadida',
  'Profile and approved facts': 'Perfil y hechos aprobados', 'Manual approval': 'Aprobación manual', 'Answer bank': 'Banco de respuestas', 'Manual job import': 'Importación manual', 'Approved job board search': 'Descubrimiento por tableros aprobados', 'Explainable job match': 'Encaje explicable', 'Application tracking': 'Seguimiento de candidaturas', 'Reviewable PDF drafts': 'Borradores PDF revisables', 'JSON export': 'Exportación JSON', 'AI processing': 'Procesamiento con IA', 'Browser autofill': 'Autorrelleno en navegador', 'Employer submission': 'Envío a empresas', 'Email access': 'Acceso al correo', 'Interview preparation': 'Preparación de entrevistas', 'Hosted multi-user accounts': 'Alojamiento multiusuario',
  'ACTIVE': 'ACTIVOS', 'OFF': 'DESACTIVADOS', 'job_application': 'Solicitud de empleo', 'APPROVED BY YOU': 'APROBADO POR TI', 'DISCARDED': 'DESCARTADO', 'Achievement': 'Logro', 'Technical experience': 'Experiencia técnica', 'Work experience': 'Experiencia laboral', 'Education': 'Formación', 'Project': 'Proyecto',
  'How should your name appear?': 'Cómo quieres que aparezca', 'Email': 'Correo', 'Two-letter ISO country code.': 'Código ISO de dos letras.', 'Save new revision': 'Guardar nueva revisión', 'Tags': 'Etiquetas', 'Discard': 'Descartar',
});

Object.assign(en, { 'Ver la vacante guardada': 'View the saved job', 'RELEASE': 'RELEASE', '{matched} de {total} habilidades con evidencia': '{matched} of {total} skills backed by evidence', 'Provisional': 'Provisional' });
Object.assign(es, { 'RELEASE': 'VERSIÓN' });

export function translate(locale: Locale, value: string, values?: Record<string, string | number>) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  let result = locale === 'en' ? (en[normalized] ?? normalized) : (es[normalized] ?? normalized);
  if (values) for (const [key, replacement] of Object.entries(values)) result = result.replaceAll(`{${key}}`, String(replacement));
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  return `${leading}${result}${trailing}`;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ locale: initialLocale, children }: { locale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.documentElement.lang = next;
    document.cookie = `locale=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, []);
  const value = useMemo(() => ({ locale, setLocale, t: (text: string, values?: Record<string, string | number>) => translate(locale, text, values) }), [locale]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used within LocaleProvider');
  return value;
}

export function LanguageToggle({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useLocale(); const target = locale === 'es' ? 'en' : 'es';
  // The visible name is the accessible name (label-in-name); `lang` lets screen readers pronounce it in the target language.
  return <button type="button" className={`language-toggle ${className}`} onClick={() => setLocale(target)} lang={target}>{target === 'en' ? 'English' : 'Español'}</button>;
}

export function localizedError(code: string, locale: Locale) {
  const spanish: Record<string, string> = {
    INVALID_INPUT: 'Revisa los campos e inténtalo de nuevo.', INVALID_PROFILE: 'No se pudo guardar el perfil. Revisa los datos.', SESSION_REQUIRED: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
    INVALID_SETUP_TOKEN: 'El token no es válido. Comprueba el token local e inténtalo de nuevo.', SETUP_TOKEN_ALREADY_USED: 'Este token ya se utilizó. Genera uno nuevo desde el proyecto local.',
    JOB_URL_INVALID: 'Añade una URL válida que empiece por https://.', LINKEDIN_URL_MANUAL_ONLY: 'Añade la descripción manualmente; no abrimos enlaces de LinkedIn.', JOB_ALREADY_EXISTS: 'Esta vacante ya está guardada.',
    BOARD_REQUIRES_REVIEW_FIRST: 'Completa primero la revisión de la fuente.', BOARD_TENANT_INVALID: 'El enlace de la fuente no parece válido. Comprueba que sea de Greenhouse, Lever o Ashby.',
    BOARD_NOT_APPROVED_FOR_DISCOVERY: 'Revisa y aprueba esta fuente antes de actualizar vacantes.', BOARD_REFRESH_COOLDOWN: 'Espera seis horas antes de volver a actualizar esta fuente.',
    SOURCE_HTTP_404: 'No encontramos ese tablero. Revisa el enlace de empleo.', SOURCE_HTTP_502: 'El proveedor de empleo no está disponible ahora. Inténtalo más tarde.', SOURCE_HTTP_503: 'El proveedor de empleo no está disponible ahora. Inténtalo más tarde.',
    SOURCE_URL_REJECTED: 'El enlace de la fuente no es válido o seguro.', SOURCE_SCHEMA_INVALID: 'No pudimos leer los datos de esta fuente. Comprueba el enlace o inténtalo más tarde.',
    DOCUMENT_FACT_LIMIT: 'Selecciona entre 1 y 50 hechos para el documento.', DOCUMENT_SIZE_LIMIT: 'El texto seleccionado es demasiado largo para generar el documento.',
    NOT_FOUND: 'No encontramos ese elemento. Actualiza la página e inténtalo de nuevo.', DATABASE_UNAVAILABLE: 'La base de datos local no responde. Comprueba que el servicio esté activo.',
    NETWORK_UNAVAILABLE: 'No hay conexión con el servicio local. Comprueba que la API esté en marcha; tus cambios siguen en el formulario.',
    APPROVAL_REQUIRES_SEPARATE_ACTION: 'La aprobación es un paso aparte. Guarda primero y aprueba después.',
    REVIEW_ACKNOWLEDGEMENT_REQUIRED: 'Marca las dos confirmaciones antes de aprobar la fuente.', REFERENCE_URL_INVALID: 'El enlace de referencia de la fuente no es válido.',
    BOARD_REFRESH_ALREADY_RUNNING: 'Ya hay una búsqueda en curso para esta fuente. Espera a que termine.', BOARD_REFRESH_FAILED: 'No pudimos leer la fuente. No se cerró ninguna vacante; inténtalo más tarde o revisa el enlace.',
    JOB_NOT_FOUND: 'La vacante ya no existe en tu espacio. Elige otra o crea una versión base.', INVALID_SHORTLIST_DECISION: 'No se pudo actualizar la lista de vacantes guardadas.',
    APPLICATION_CREATION_STATE_UNSUPPORTED: 'Una candidatura nueva solo puede empezar como borrador o como enviada por ti.', APPLICATION_ALREADY_EXISTS: 'Ya tienes una candidatura para esta vacante.',
    INVALID_STATE_TRANSITION: 'Ese cambio de estado no está permitido desde el estado actual.', CONFIRMATION_EVIDENCE_REQUIRED: 'Confirma que enviaste la candidatura para marcarla como enviada.',
    RECRUITMENT_STAGE_CANNOT_REGRESS: 'Para volver a una etapa anterior, confirma que es una corrección.', ASSIST_ACTIVE_ATTEMPT: 'Resuelve el intento asistido antes de cambiar el estado de la candidatura.', STALE_APPLICATION_VERSION: 'Esta candidatura cambió en otra pestaña. Hemos recargado los datos; repite el cambio.',
    CAPABILITY_NOT_AVAILABLE: 'Esta versión no envía ni comprueba candidaturas en webs de empresas.', INVALID_EVENT: 'La nota no es válida o es demasiado larga.',
    INVALID_DOCUMENT_REQUEST: 'Pon un nombre y elige entre 1 y 50 hechos aprobados.', DUPLICATE_FACT_ID: 'Hay hechos repetidos en la selección.',
    PROFILE_NOT_CONFIGURED: 'Guarda tu perfil antes de generar documentos.', FACTS_MUST_BE_APPROVED_IN_CURRENT_PROFILE: 'Algunos hechos ya no están aprobados en la revisión actual del perfil. Recargamos la lista; revisa la selección.',
    DOCUMENT_RENDER_FAILED: 'No se pudo generar el PDF en este equipo. No se guardó ninguna versión; inténtalo de nuevo.', EXPLICIT_REVIEW_REQUIRED: 'Confirma que leíste el documento antes de aprobarlo.',
    DOCUMENT_ALREADY_REVIEWED: 'Esta versión ya se revisó.', PROFILE_CHANGED_REGENERATE_DOCUMENT: 'Tu perfil cambió después de generar esta versión. Genera una nueva para aprobarla.',
    DOCUMENT_FILE_UNAVAILABLE: 'El archivo PDF ya no está disponible en este equipo. Genera una nueva versión.', DOCUMENT_HASH_MISMATCH: 'El PDF guardado no coincide con su huella. Genera una nueva versión.',
    DOCUMENT_PATH_INVALID: 'La ruta del documento no es válida.', EXPORT_ARTIFACT_LIMIT: 'La exportación supera el límite de tamaño. Descarga los PDF por separado.',
    RATE_LIMIT_EXCEEDED: 'Has realizado muchas acciones seguidas. Espera un minuto e inténtalo de nuevo.', DUPLICATE_RECORD: 'Ese registro ya existe.', INTERNAL_ERROR: 'El servicio local tuvo un error. Inténtalo de nuevo.',
    ANSWER_REVISION_STALE: 'Existe una versión más reciente de esta respuesta. Recarga los datos y revisa la última versión.',
    PROFILE_REVISION_CONFLICT: 'Tu perfil cambió en otra pestaña o ventana. Recarga la última versión; tus cambios sin guardar se conservan para que puedas guardarlos de nuevo.',
    FACT_NOT_IN_CURRENT_REVISION: 'Este hecho pertenece a una revisión anterior del perfil. Recarga la última versión e inténtalo de nuevo.',
  };
  const english: Record<string, string> = {
    INVALID_INPUT: 'Check the fields and try again.', INVALID_PROFILE: 'We could not save your profile. Check the details.', SESSION_REQUIRED: 'Your session expired. Sign in again.',
    INVALID_SETUP_TOKEN: 'That token is not valid. Check your local setup token and try again.', SETUP_TOKEN_ALREADY_USED: 'This token has already been used. Create a new one from the local project.',
    JOB_URL_INVALID: 'Enter a valid URL starting with https://.', LINKEDIN_URL_MANUAL_ONLY: 'Paste the job description manually; LinkedIn links are not opened.', JOB_ALREADY_EXISTS: 'This job is already saved.',
    BOARD_REQUIRES_REVIEW_FIRST: 'Review this source before enabling it.', BOARD_TENANT_INVALID: 'This job board link looks invalid. Check that it is from Greenhouse, Lever, or Ashby.',
    BOARD_NOT_APPROVED_FOR_DISCOVERY: 'Review and approve this source before refreshing jobs.', BOARD_REFRESH_COOLDOWN: 'Wait six hours before refreshing this source again.',
    SOURCE_HTTP_404: 'We could not find that job board. Check the careers link.', SOURCE_HTTP_502: 'The job board provider is unavailable right now. Try again later.', SOURCE_HTTP_503: 'The job board provider is unavailable right now. Try again later.',
    SOURCE_URL_REJECTED: 'This job source link is invalid or unsafe.', SOURCE_SCHEMA_INVALID: 'We could not read this source. Check the link or try again later.',
    DOCUMENT_FACT_LIMIT: 'Select between 1 and 50 facts for this document.', DOCUMENT_SIZE_LIMIT: 'The selected text is too long to generate this document.',
    NOT_FOUND: 'We could not find that item. Refresh the page and try again.', DATABASE_UNAVAILABLE: 'The local database is not responding. Check that the service is running.',
    NETWORK_UNAVAILABLE: 'The local service is not reachable. Check that the API is running; your changes are still in the form.',
    APPROVAL_REQUIRES_SEPARATE_ACTION: 'Approval is a separate step. Save first, then approve.',
    REVIEW_ACKNOWLEDGEMENT_REQUIRED: 'Tick both confirmations before approving this source.', REFERENCE_URL_INVALID: 'The source reference link is not valid.',
    BOARD_REFRESH_ALREADY_RUNNING: 'A search is already running for this source. Wait for it to finish.', BOARD_REFRESH_FAILED: 'We could not read this source. No jobs were closed; try again later or check the link.',
    JOB_NOT_FOUND: 'That job no longer exists in your workspace. Choose another or create a base version.', INVALID_SHORTLIST_DECISION: 'We could not update your saved jobs.',
    APPLICATION_CREATION_STATE_UNSUPPORTED: 'A new application can only start as a draft or as applied by you.', APPLICATION_ALREADY_EXISTS: 'You already have an application for this job.',
    INVALID_STATE_TRANSITION: 'That status change is not allowed from the current status.', CONFIRMATION_EVIDENCE_REQUIRED: 'Confirm that you sent the application to mark it as applied.',
    RECRUITMENT_STAGE_CANNOT_REGRESS: 'To go back to an earlier stage, confirm that it is a correction.', ASSIST_ACTIVE_ATTEMPT: 'Resolve the assisted attempt before changing application status.', STALE_APPLICATION_VERSION: 'This application changed in another tab. We reloaded it; repeat your change.',
    CAPABILITY_NOT_AVAILABLE: 'This version does not submit or check applications on employer websites.', INVALID_EVENT: 'The note is not valid or is too long.',
    INVALID_DOCUMENT_REQUEST: 'Add a name and choose between 1 and 50 approved facts.', DUPLICATE_FACT_ID: 'The selection contains repeated facts.',
    PROFILE_NOT_CONFIGURED: 'Save your profile before generating documents.', FACTS_MUST_BE_APPROVED_IN_CURRENT_PROFILE: 'Some facts are no longer approved in your current profile revision. We reloaded the list; check your selection.',
    DOCUMENT_RENDER_FAILED: 'The PDF could not be generated on this device. No version was saved; try again.', EXPLICIT_REVIEW_REQUIRED: 'Confirm you read the document before approving it.',
    DOCUMENT_ALREADY_REVIEWED: 'This version has already been reviewed.', PROFILE_CHANGED_REGENERATE_DOCUMENT: 'Your profile changed after this version was generated. Generate a new one to approve it.',
    DOCUMENT_FILE_UNAVAILABLE: 'The PDF file is no longer available on this device. Generate a new version.', DOCUMENT_HASH_MISMATCH: 'The stored PDF does not match its fingerprint. Generate a new version.',
    DOCUMENT_PATH_INVALID: 'The document path is not valid.', EXPORT_ARTIFACT_LIMIT: 'The export is over the size limit. Download the PDFs separately.',
    RATE_LIMIT_EXCEEDED: 'Too many actions in a short time. Wait a minute and try again.', DUPLICATE_RECORD: 'That record already exists.', INTERNAL_ERROR: 'The local service hit an error. Try again.',
    ANSWER_REVISION_STALE: 'A newer version of this answer exists. Reload the data and review the latest version.',
    PROFILE_REVISION_CONFLICT: 'Your profile changed in another tab or window. Reload the latest version; your unsaved edits are kept so you can save them again.',
    FACT_NOT_IN_CURRENT_REVISION: 'This fact belongs to an older profile revision. Reload the latest version and try again.',
  };
  if (code.startsWith('SOURCE_HTTP_')) return (locale === 'en' ? english : spanish)[code] ?? (locale === 'en' ? 'The job board provider returned an error. Try again later.' : 'El proveedor de empleo devolvió un error. Inténtalo más tarde.');
  const messages = locale === 'en' ? english : spanish;
  if (messages[code]) return messages[code];
  // Unmapped codes get a generic message: server `detail` can be raw technical text (stack, SQL, provider errors).
  return messages[code] ?? (locale === 'en' ? 'Something went wrong. Try again.' : 'Ha ocurrido un error. Inténtalo de nuevo.');
}

export function currentLocale(): Locale {
  return typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'es';
}
