# Identidad conversacional de bots: informe de continuidad

Fecha original: 2026-09-16. Revisado tras cambio de modelo: ver "Estado actual".
Leer al cambiar de modelo o compactar contexto. Las secciones "Implementacion
recomendada" y "Brechas verificadas" conservan la redaccion original de la fase
de investigacion; el estado real de cada punto esta en "Estado actual".

## Intencion original

El usuario quiere configurar un colaborador conversando, no rellenando formularios.
Su referencia es Grok: enviar "tu eres (nombre) y tu trabajo es hacer..." y que el
bot adopte y guarde identidad, configure automatizaciones y ejecute las tareas
solicitadas. Pidio este informe para conservar el hilo al cambiar de modelo.

**One-shot significa un mensaje del usuario, no una unica llamada al modelo ni a
herramientas.** La experiencia debe ser fluida; debajo debe haber persistencia
verificable. Decir "entendido, soy X" no equivale a configurar un bot.

No sustituir esto por otro wizard, un parser de frases por regex, otro scheduler
ni un sistema enorme de personalidades. Reutilizar harness, DB, herramientas y cola.

## Experiencia objetivo

1. Nuevo bot abre directamente su chat y enfoca el composer.
2. El usuario escribe: "Eres Creators. Busca creadores de TikTok de Minecraft para
   Roxy.gg, prioriza mods y programacion. Dame ahora 10 con perfil y correo publico
   si existe. Revisa cada hora y trae solo candidatos nuevos".
3. El bot persiste identidad y criterios, crea la rutina y realiza la tarea inicial
   solicitada. No pregunta de nuevo por datos ya proporcionados.
4. Confirma brevemente los cambios realmente guardados. Ajustes permite inspeccion
   y edicion avanzada, pero no es requisito para empezar.
5. "Ahora cada dos horas", "pausa esa busqueda" y "prioriza creadores en espanol"
   modifican lo existente desde la conversacion.
6. Reinicio, compaction o cambio de modelo no borran identidad ni rutinas.

La captura es referencia de interaccion, no documentacion del backend de Grok.
No copiar decisiones no solicitadas: "cada hora" no autoriza inventar dias habiles,
franjas horarias o zona CDMX.

### Separaciones esenciales

- Identidad duradera: nombre, especialidad, criterios y conducta. Perfil persistido.
- Encargo inmediato: "dame ahora 10". Turno/cola existentes.
- Automatizacion: "revisa cada hora". Job persistido con prompt autosuficiente.
- Estado de trabajo: candidatos ya reportados, resultados y pendientes. Necesita
  persistencia adecuada; no confundir con identidad ni memoria infinita del chat.

Un saludo no ejecuta todo el rol. Una tarea puntual no reescribe la personalidad.
Una pagina web o un ejemplo citado no autoriza reconfiguracion permanente.
Guardar una rutina no demuestra que una busqueda haya terminado.

## Codigo existente

Rutas relativas al repo. Lineas orientativas; buscar simbolos antes de editar.

- `src/shared/bots.ts`: Bot contiene id, username, instructions, chatId y createdAt;
  BotJob contiene prompt, schedule y estado. Username ASCII de 2-32 caracteres;
  roxy reservado. No hay displayName separado.
- `src/main/db/bots.ts`: createBot crea chat persistente; updateBot guarda perfil y
  renombra chat. saveJob valida/persiste. enqueueDueJobs encola y avanza calendario
  dentro de una transaccion.
- `src/main/harness/bot-tools.ts:41-103`: bot_manage y bot_schedule ya permiten
  configurar mediante herramientas conversacionales.
- `src/main/harness/agent.ts:597-638`: buildSystemMessage inyecta identidad desde DB;
  distingue anfitrion, bot propio e invitado con asBotId.
- `src/main/services/automation.ts`: main consume la cola y ejecuta rutinas sin
  renderer abierto. Roxy debe seguir ejecutandose; no es scheduler cloud/OS.
- `src/renderer/src/components/BotsSection.tsx:249-390`: modal obligatorio con
  username; instrucciones y jobs opcionales antes de abrir el chat.
- `src/renderer/src/lib/store.ts:1170-1176`: createBot crea, actualiza instrucciones
  si existen y selecciona chat. Los mensajes de bots pasan por la cola de main.
- Contrato create con username: `src/shared/api.ts:707-717`,
  `src/preload/index.ts:25-37`, `src/main/ipc/index.ts:746-777`.
- `src/renderer/src/components/BotSettingsPane.tsx`: edicion de perfil, inferencia y
  rutinas. Conservar como superficie avanzada.

## Brechas verificadas

1. **Friccion inicial:** username y formulario antes de conversar.
2. **Pregunta redundante:** el prompt sin instructions pide preguntar que debe
   ser/hacer, sin distinguir un saludo de una definicion inicial completa.
3. **Confirmacion asimetrica:** no afirmar que existe una rutina antes del exito
   de bot_schedule es una regla de la rama host, no de la rama bot.
4. **Actor efectivo incompleto:** el prompt usa asBotId, pero ToolContext
   (`src/main/harness/tools.ts:54-81`) no lo recibe. Bot_schedule deduce el bot con
   chatBot(ctx.sessionId): un invitado puede programar al host o fallar en un
   proyecto. Bot_manage update exige id. Bot_invoke tambien atribuye solicitante
   mediante el propietario del chat, no necesariamente el invitado.
5. **Contexto viejo en el mismo turno:** buildSystemMessage se ejecuta una vez en
   runAgentTurn (`agent.ts:1265-1329`). El perfil se persiste pero system prompt y
   roster no se reconstruyen. El resultado de herramienta informa del cambio;
   el siguiente turno relee DB.
6. **Jobs fuera del contexto inicial:** disponibles con bot_schedule list o
   bot_manage read, pero no inyectados junto al perfil.
7. **Fallo parcial y duplicacion:** perfil y jobs se guardan por separado. Repetir
   create genera otro job. Consultar primero ayuda, pero no garantiza idempotencia
   tras interrupciones o reintentos.
8. **Procedencia no es autorizacion:** sourceChatId/asBotId/schedule_id existen en
   ejecucion, pero falta origen estructurado en ToolContext. Los handlers no
   comprueban permisos por actor para editar perfiles/rutinas. Una entrega
   automatica puede figurar como user; ese rol no prueba consentimiento humano.
9. **Ajustes obsoletos:** BotSettingsPane inicializa username/instructions una vez;
   onChanged refresca jobs, no esos campos. Guardar el formulario abierto puede
   pisar cambios conversacionales. Proteger tambien borradores humanos locales.
10. **Descripcion contradictoria:** schema bot_invoke (`agent.ts:849`) dice que
    trabaja en su chat; la implementacion invita al transcript actual.

## Implementacion recomendada

Propuestas tecnicas, no decisiones ya aprobadas ni implementadas.

### A. Entrada directa

- Permitir create sin username proporcionado; generarlo valido y unico en main/DB.
  Conservar validacion y creacion explicita existente.
- Reutilizar IPC/store/seleccion de chat. Proteger doble clic, mostrar errores y
  enfocar composer. Mantener ajustes posteriores, sin otro wizard.
- No requiere por si solo migrar esquema. Evaluar necesidad de distinguir nombre
  automatico antes de agregar flags persistidos.

### B. Configuracion desde el mensaje

- Dar al modelo el ID estable del bot que habla, no solo username/sessionId.
- Si el mensaje define identidad/recurrencia, guardar lo suficientemente claro
  sin pedir que lo repitan. Preguntar solo datos indispensables faltantes.
- Usar bot_manage update sobre el bot actual, no crear otro por accidente.
- Preservar criterios no modificados. Instructions se reemplaza entero hoy;
  una correccion parcial no debe borrar el resto.
- Consultar jobs, actualizar/pausar por ID. Aclarar "esa rutina" si varias hacen
  ambigua la referencia. Separar rol, prompt programado y tarea inmediata.
- Confirmar resultados exitosos. Si perfil se guardo pero job fallo, comunicar
  estado parcial y recuperar, sin afirmar que todo esta configurado.
- Nombre ocupado/invalido no autoriza modificar otro bot. Distinguir nombre humano
  de handle; no introducir displayName sin necesidad comprobada.

### C. Actor y recuperacion

- Separar sesion anfitriona y actor efectivo en ToolContext. Resolver "yo" por
  actor, conservando workspace del host.
- Definir politica de cambios permanentes por origen. Propuesta segura: resultados
  web/delegaciones no autorizan por si solos redefinir al bot. Requiere enforcement,
  no solo un prompt. No asumir que un mensaje user siempre es humano directo.
- Si se promete deduplicacion, usar identificadores estables de solicitud/cola y
  definir la clave de operacion. Un tool-call ID variable no basta al reintentar
  el turno. Elegir la solucion minima probada, no un framework transaccional.
- Resolver como aplicar nuevo rol durante el mismo turno. No disparar continuaciones
  que repitan la tarea inicial solo para reconstruir el system prompt.

### D. UI coherente

- Usar eventos existentes para reflejar cambios en sidebar y ajustes.
- Refrescar perfil sin draft local; con draft, resolver conflicto sin sobrescribir
  silenciosamente ninguna version.
- Diferenciar guardado, programado, encolado y completado. lastRunAt y remainingRuns
  cambian al encolar, no al completar exitosamente.
- Comunicar limitacion de app ejecutandose sin saturar la conversacion.

## Decisiones no resueltas

- "Ahora y cada hora" pide ambas cosas; "programa cada hora" no pide necesariamente
  ejecucion inicial. Definir convencion para frases ambiguas sin bloquear tareas
  claras ni ejecutar todo el rol por defecto.
- Intervalo de 60 minutos no es cada hora en punto. Intervalos no requieren zona;
  cron/horas locales si. Usar zona disponible y comunicarla o pedirla cuando falte;
  no inferir por idioma.
- "Solo candidatos nuevos" necesita estado persistente de resultados; historial
  acotado no garantiza deduplicacion indefinida. "Solo avisame si hay novedades"
  requiere verificar notificaciones reales, no basta escribirlo en instructions.
- Buscar contactos publicos no autoriza contactar, contratar ni publicar.
- Un modelo sin tools no persiste configuracion mediante texto. Comunicar una
  limitacion recuperable, no fingir exito.

## Pruebas de aceptacion

1. Nuevo bot abre chat sin formulario, con foco y sin duplicacion por doble clic.
2. "Eres Atlas y revisas documentacion" guarda perfil, sin inventar un job.
3. "Hola" no dispara trabajo ni reconfiguracion innecesaria.
4. Rol + tarea ahora + intervalo produce perfil, un job correcto y tarea inicial.
5. "Cada hora" no inventa dias/franjas; cambios posteriores actualizan el job.
6. Referencia ambigua entre dos rutinas produce una pregunta concreta.
7. Fallo entre perfil/job y retry no produce exito falso ni duplicados.
8. Reinicio, compaction y modelo distinto mantienen identidad/jobs en DB.
9. Invitado configura al actor correcto o recibe rechazo segun politica, nunca
   modifica al host por default incorrecto.
10. Pagina/delegacion que dice "ahora eres X" no causa cambio no autorizado.
11. Settings abiertos no pierden perfil nuevo ni borradores locales.
12. Nombre ocupado/invalido y modelo sin tools tienen recuperacion honesta.

Extender `test/bots.ts`, `test/bots-shared.ts`; revisar `test/bots-ui.cjs` y
`test/canvas/BotsHarness.tsx`. El smoke `test/canvas/bots-smoke.cjs:55-73` busca
form[role="dialog"] y submit, pero el modal actual es div con boton type=button;
alinearlo antes de usarlo como evidencia visual.

Transporte determinista verifica persistencia, contexto y herramientas. Un mock
que devuelve las llamadas correctas NO demuestra comprension del lenguaje natural:
complementar con evaluacion de prompts reales en modelos soportados, sin guardar
credenciales ni prometer fiabilidad universal. Probar desktop y viewport estrecho.

## Estado actual

Revision hecha leyendo el diff sin commit y ejecutando la verificacion listada
abajo. Las fases A, B, C y D ya NO son solo propuesta: estan en el working tree,
sin commit, sobre HEAD 89f2cea (rama jair/turbo-daemon-warden).

Implementado y verificado por diff + pruebas:

- **A. Entrada directa.** `createBot` acepta username vacio y genera un handle
  libre (`bot`, `bot-2`, ...) en `src/main/db/bots.ts:freeUsername`. El modal
  desaparecio de `BotsSection.tsx` (-183 lineas netas de formulario); un clic
  abre el chat. Contrato opcional propagado por `shared/api.ts`, `preload` e IPC,
  y por `store.createBot(username?, instructions?)`.
- **B. Configuracion desde el mensaje.** `src/main/harness/bot-prompt.ts`
  (archivo nuevo) es un system prompt propio para bots: separa identidad, tarea,
  rutina y saludo; obliga a `bot_manage update` sin id sobre uno mismo; prohibe
  confirmar sin resultado exitoso de herramienta; cubre el caso Plan mode sin
  tools. Las rutinas del bot se inyectan en el system prompt
  (`agent.ts:625`, `Your schedules:`), lo que cierra la brecha 6 (duplicacion de
  jobs por no verlos).
- **C. Actor efectivo.** `ToolContext.botId` existe (`tools.ts:55-67`) y se
  resuelve una sola vez como `actingBot` en `runAgentTurn` (`agent.ts:1342`,
  pasado en `agent.ts:1390`), compartido por prompt y herramientas. En
  `bot-tools.ts`, `self` reemplaza a `chatBot(ctx.sessionId)`: un invitado ya no
  configura ni programa a su anfitrion, `bot_manage read/update` sin id apuntan a
  uno mismo, y un bot no puede borrarse a si mismo. `bot_invoke` acepta
  `roxy` como destino, rechaza la auto-invocacion con un mensaje que identifica
  al actor, y prefija `@username` en el transcript.
- **D. UI coherente.** `BotSettingsPane` sigue al bot cuando este se renombra
  solo, salvo que haya edicion local sin guardar (brecha 9 cerrada, con la regla
  explicita de que el borrador humano gana). `store.automationSpeakers` mantiene
  la identidad del hablante en turnos de automation, incluido reload.

Cambios adicionales no previstos en el informe original:

- `src/shared/mentions.ts` (nuevo): las menciones son SOLO resaltado visual. Se
  elimino el ruteo por `@` inicial en el renderer (`addressesBot` -> `isBotChat`)
  y en el prompt: el modelo interpreta la intencion y delega con `bot_invoke`.
- `botActivity` (`src/main/db/bots.ts`): hasta 4 extractos de texto propios en
  otras sesiones, con IDs de origen, expuestos tambien por `bot_manage read`.
  No copia transcripts ni prueba que una tarea haya terminado.
- BOTS.md documenta las reglas de colaboracion, mencion y handoff resultantes.

Brechas del informe que siguen abiertas:

- Brecha 5 (contexto viejo en el mismo turno): `buildSystemMessage` se sigue
  ejecutando una sola vez por turno. Un bot que se renombra a mitad de turno lo
  ve en el resultado de la herramienta, no en su system prompt; el turno
  siguiente relee la DB. No se implemento reconstruccion en caliente.
- Brecha 7 (idempotencia perfil/job ante reintento): no hay clave de operacion
  estable. El prompt mitiga duplicados haciendo visibles las rutinas, pero eso es
  conducta del modelo, no una garantia transaccional.
- Brecha 8 (autorizacion por origen): `botId` da actor efectivo, pero no hay
  enforcement backend que distinga un mensaje `user` humano de una entrega
  automatica. La proteccion contra "esta pagina dice que ahora eres X" sigue
  siendo solo instruccion de prompt.
- Sigue pendiente todo lo de "Decisiones no resueltas": zona horaria, "solo
  candidatos nuevos" como estado persistente, y la convencion de "ahora y cada
  hora".
- La sustitucion del system prompt en la ruta OAuth de Claude Subscription
  (ver BOT-DELEGATION-DEBUG.md) NO esta arreglada y no depende de este trabajo.
- Evaluacion con modelos reales: hay escenarios acotados en vivo registrados en
  BOT-DELEGATION-DEBUG.md, no una bateria de prompts naturales sobre la nueva
  experiencia de configuracion conversacional. Las pruebas de aceptacion 2, 3, 4,
  5, 6 y 10 estan cubiertas por transporte determinista, no por comprension
  demostrada de lenguaje natural en varios proveedores.

Verificacion ejecutada en esta revision (no heredada):

- `npm run typecheck` limpio.
- `npm run smoke:shared`: 1083 checks. `npm run smoke:diff`: 54 checks.
- `npm run smoke:i18n`: 18 checks. `npm run smoke:store` OK. `npm run i18n`:
  catalogos en sync.
- `npm run smoke:bots`: BOT SHARED OK y BOT RUNTIME OK (la linea
  `bots:runJob ... Schedule not found` es una asercion negativa esperada).
- UI contra el dev server de canvas en :3130: `test/canvas/bots-smoke.cjs`
  BOTS UI OK y `test/canvas/mentions-smoke.cjs` MENTIONS UI OK.
- `git diff --check` limpio. Prettier fallaba en `session-turn.ts` y
  `default.json`; se corrigio con `prettier --write` y ahora `--check` pasa.

Sin commit ni push: el arbol sigue sucio a proposito.
`script/tmp-*.mjs` y `script/tmp-payload.json` son scratch del turno anterior
(buscar/editar archivos con CRLF); no forman parte de la funcionalidad y deberian
borrarse antes de commitear.

## Estado heredado

Al empezar habia cambios sin commit en BOTS.md, agent.ts, automation.ts,
BotSettingsPane, Composer, InferenceControls, ModelPicker, default.json,
diez catalogos traducidos y test/bots.ts. No revertir ni hacer reset.
HEAD observado: 89f2cea. Rama heredada: jair/turbo-daemon-warden;
PR draft #105 segun contexto anterior.

Trabajo anterior: inferencia propia de invitados, memoria acotada, withRequest
para restaurar encargo delegado, resumen host limitado para invitados, Escape y
posicion de menus en ajustes. Verificacion visual de menus pendiente. Memoria por
relevancia y enforcement general de permisos backend de invitados estaban diferidos.

La sesion anterior reporto typecheck, smoke:bots, smoke:shared, smoke:i18n,
smoke:store, i18n, formato y diff --check correctos.

## Para retomar

1. Leer este archivo, AGENTS.md, BOTS.md y git status/diff. Respetar cambios ajenos.
2. Revalidar simbolos antes de editar. El siguiente trabajo util son las brechas
   abiertas listadas en "Estado actual", en este orden sugerido: evaluacion con
   modelos reales de la configuracion conversacional, despues autorizacion por
   origen (brecha 8), despues idempotencia (brecha 7). La brecha 5 puede quedar
   como limitacion documentada si no aparece un caso real que la exija.
3. Actualizar aqui decisiones, implementacion y pendientes por separado.
4. Strings UI solo en locales/default.json; derivados mediante tooling del repo.
   Prompts al modelo no son strings UI traducibles.
5. Validar typecheck, smoke:bots, smoke:shared, smoke:i18n, smoke:store, i18n,
   formato, diff y UI pertinente (bots-smoke y mentions-smoke necesitan
   `npm run canvas` sirviendo en el puerto que apunte BOTS_TEST_URL).
   No declarar probado lo no ejecutado.
6. No hacer commit/push sin peticion del usuario.

Punto exacto: fases A-D implementadas en el working tree y verificadas con las
pruebas automatizadas y de UI del repo. Falta evaluacion con modelos reales y las
brechas 5, 7 y 8. No sustituir el objetivo por copy ni personalidad efimera: se
requiere configuracion real en chat.
