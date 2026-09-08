# Roxy+ - channels

Fork de Roxy con **canales**: varios bots en un mismo chat, que se pasan el
turno entre ellos. Guardado aparte del repo de Desktop, que sigue limpio en
`main`.

- Rama: `roxy-plus/channels`
- Base: `cd9f244` (main de FreddyJD/roxy cuando se hizo el trabajo)
- Todo el trabajo esta en el commit `feat(channels): bots that talk to each other in one chat`

## Arrancarlo

```powershell
cd "$env:USERPROFILE\Documents\Roxy+"
npm install     # node_modules NO se copio (888 MB)
npm run dev
```

`npm run typecheck` y `npm run smoke:shared` (1020 checks) pasan.

## Que hace

Una sesion es un **canal**, no un chat uno-a-uno. Roxy es el host y siempre
esta; los especialistas se agregan al lado, estilo WhatsApp. Se les habla con
`@Nombre`, y un mensaje sin mencion va a Roxy - asi el canal nunca queda sin
nadie escuchando.

Un miembro es **Roxy con una especialidad**: su brief se _anade_ al prompt base,
no lo reemplaza, asi hereda el workspace, las reglas de tools, las skills y el
estilo de la casa en vez de arrancar como un modelo en blanco.

## Los cuatro bugs que costaron encontrar

Todos eran la misma raiz vista de distintos angulos: **el modelo no sabia que
el canal existia.**

1. **El roster no entraba al prompt.** Solo se inyectaba el brief del miembro
   que hablaba. Al pedirle "llama a @Bobo", Roxy buscaba un usuario de GitHub
   llamado Bobo, no lo encontraba, y caia al tool `task` - que es la forma
   equivocada: un subagente es un hijo en blanco de _su propio_ contexto, que
   hereda sus errores y reporta solo de vuelta a el, y nunca aparece en el canal
   como par. Lo arregla `channelPrompt()` en `src/shared/channel-members.ts`.

2. **El enrutado le daba el trabajo entero al mencionado.** Se tomaba la
   _primera_ mencion en cualquier posicion, asi que "crea el comando, crea el PR
   y **despues** llama a @Bobo" se enrutaba completo a Bobo. Ahora solo cuenta
   como dirigido si el mensaje **abre** con la mencion; una mencion a mitad de
   frase es hablar _sobre_ alguien, y el turno se queda con el host, que hace el
   trabajo y recien entonces pasa el turno.

3. **El brief se leia como la tarea.** Pegado crudo, un bot con "revisas PRs y
   dejas un roadmap" se ponia a clonar y diffear al recibir un "hola". Ahora el
   brief va enmarcado como _standing identity_, y lo que decide que hacer es el
   ultimo mensaje del canal.

4. **Gemini rechazaba el hand-off con 400.** En un relevo nadie escribe un
   mensaje nuevo, asi que el transcript _terminaba_ en un turno de assistant:
   `Requests ending with a model turn are not supported`. Ya existia un `while`
   que normalizaba el **inicio** de la ventana, pero nada el **final**. Ahora el
   hand-off se replantea como linea de rol `user`, atribuida (`[Roxy]: @bobo el
PR esta listo`), lo que ademas arregla un fallo silencioso en otros
   providers, que lo interpretaban como "segui escribiendo esa respuesta" en vez
   de "responde a esto".

## Los dos campos del panel (la confusion que quedo documentada)

- **One-line role** -> `role`. Etiqueta corta. Se muestra junto al nombre y en
  el roster que ven los otros bots. _Tambien va al prompt_, en la linea de
  identidad - por eso poner el brief aca "medio funciona" y nada te avisa.
- **Its full instructions** -> `systemPrompt`. El brief completo, al final del
  prompt como la instruccion mas especifica.

El textarea ahora se ilumina cuando hay nombre pero no instrucciones.

## Donde mirar

| Que                                                 | Donde                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| Roster, enrutado, hand-off, aislamiento de contexto | `src/shared/channel-members.ts`                                      |
| Panel de miembros                                   | `src/renderer/src/components/ChannelMembersPanel.tsx`                |
| Avatares/acentos                                    | `src/renderer/src/components/BotAvatar.tsx`                          |
| Relevo y armado de la ventana                       | `src/renderer/src/lib/store.ts` (`sendMessage`, `buildChatMessages`) |
| Inyeccion del bloque de canal                       | `src/main/harness/agent.ts` (`memberPrompt`)                         |
| Tests                                               | `test/shared.ts` (buscar `channel:`)                                 |

## Pendiente

- Las skills son por _agente_ y workspace, no por miembro: todos los bots ven
  las mismas que Roxy. Un allowlist por miembro no existe todavia.
- `MAX_HANDOFF_HOPS` acota la cadena de relevos; cada hop es un turno completo.
