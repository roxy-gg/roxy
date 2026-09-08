import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/renderer/src/locales/es.json'
const raw = readFileSync(path, 'utf8')
const crlf = raw.includes('\r\n')
const json = JSON.parse(raw)

json.bots = {
  attach: 'Añadir',
  chatEmptyBody:
    'Aquí solo responde {{name}} — úsalo para enseñarle y para preguntarle directamente. En un proyecto, llega al mismo bot con @{{name}}.',
  chatEmptyNoBrief:
    '{{name}} todavía no tiene instrucciones, así que responderá como Roxy a secas. Edita el bot para decirle cómo trabajar.',
  chatEmptyTitle: 'Este es tu chat con {{name}}',
  chatPlaceholder: 'Escríbele a {{name}}…',
  create: 'Crear bot',
  delete: 'Eliminar bot',
  descriptionHint:
    'Una línea sobre para qué sirve. La ves tú y también los demás bots con los que trabaja.',
  descriptionLabel: 'Descripción',
  descriptionPlaceholder: 'p. ej. Revisa los diffs antes de publicarlos',
  edit: 'Editar bot',
  editTitle: 'Editar {{name}}',
  instructionsHint:
    'Cómo debe trabajar: qué hacer siempre, qué no hacer nunca, cómo se ve un buen resultado. Esto es lo que lo diferencia de Roxy.',
  instructionsLabel: 'Instrucciones',
  instructionsPlaceholder:
    'Revisas cambios buscando errores y riesgos.\n\nLee el diff completo antes de comentar. Señala pruebas que faltan y errores sin manejar. Sé específico: nombra el archivo y la línea. No reescribas el código tú mismo.',
  lookLabel: 'Apariencia',
  nameHint: 'Así lo llamarás en un proyecto: @Nombre.',
  nameLabel: 'Nombre',
  namePlaceholder: 'p. ej. Revisor',
  new: 'Nuevo bot',
  newFooter: 'Puedes cambiar todo esto más adelante.',
  newShort: 'Nuevo',
  newTitle: 'Nuevo bot',
  openChat: 'Abrir chat',
  save: 'Guardar',
  savedGroup: 'Tus bots',
  subtitle:
    'Un especialista con el que puedes chatear aparte y mencionar con @ en cualquier proyecto.'
}

// Re-sort so the catalog keeps the alphabetical shape the sync script writes.
const sorted = Object.fromEntries(Object.entries(json).sort(([a], [b]) => a.localeCompare(b)))
const out = JSON.stringify(sorted, null, 2) + '\n'
writeFileSync(path, crlf ? out.replace(/\n/g, '\r\n') : out)
console.log('es.json bots translated')
