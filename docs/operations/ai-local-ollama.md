# IA local con Ollama / Local AI with Ollama

## Español

1. Instala Ollama y descarga desde Ollama un modelo local compatible. Career Stack no instala ni descarga modelos.
2. Desactiva las funciones en la nube en el servidor de Ollama, por ejemplo con `OLLAMA_NO_CLOUD=1` o `disable_ollama_cloud: true` en `~/.ollama/server.json`, y reinicia Ollama.
3. Inicia Ollama en este equipo. Career Stack usa por defecto `http://127.0.0.1:11434`. La persona que administra la instalación puede configurar `OLLAMA_BASE_URL`, pero solo se aceptan `127.0.0.1` o `::1` en el puerto `11434`.
4. En **Ajustes → IA local con Ollama**, comprueba los modelos locales, selecciona uno, marca la confirmación de nube desactivada y conecta.
5. En una oferta o en la creación de una búsqueda, elige la acción de Ollama. Antes de empezar se muestra la información que se enviará. La tarea no comienza hasta que la autorizas.

Career Stack puede comprobar que el endpoint es local y que el modelo aparece instalado. No puede verificar que el proceso de Ollama tenga desactivadas las funciones en la nube; la confirmación se guarda como una declaración de la persona usuaria. Los modelos con sufijos de nube como `:cloud`, `-cloud` o `_cloud` no se ofrecen. La calidad, el tiempo y el uso de memoria dependen del modelo y del equipo; no se garantiza un buen rendimiento con 8 GB.

La primera versión solo admite análisis de ofertas y borradores de búsqueda. No envía solicitudes de empleo ni realiza tareas automáticas con Ollama.

## English

1. Install Ollama and download a compatible local model through Ollama. Career Stack does not install or download models.
2. Disable cloud features in the Ollama server, for example with `OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud: true` in `~/.ollama/server.json`, then restart Ollama.
3. Start Ollama on this computer. Career Stack defaults to `http://127.0.0.1:11434`. The installation administrator may configure `OLLAMA_BASE_URL`, but only `127.0.0.1` or `::1` on port `11434` is accepted.
4. In **Settings → Local AI with Ollama**, check installed local models, select one, confirm that cloud features are disabled, and connect.
5. On a job or while creating a search, choose the Ollama action. The app previews the information to be sent before the task starts. It runs only after you allow it.

Career Stack can verify that the endpoint is local and that the model is listed as installed. It cannot verify whether the Ollama server process has cloud features disabled; the confirmation is stored as a user attestation. Models with cloud suffixes such as `:cloud`, `-cloud`, or `_cloud` are not offered. Quality, latency, and memory use depend on the model and computer; good performance on 8 GB is not guaranteed.

The first version supports job analysis and search drafts only. It does not submit applications or run automatic tasks through Ollama.
