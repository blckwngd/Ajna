// Parley — kleine JSON-native Dialogsprache für NPCs und Chatbots.
// Format, Regelaufbau und Beispiele: README.md
export { Parley, Conversation } from './src/engine.mjs'
export { compileDoc } from './src/doc.mjs'
export { compilePattern, matchPattern, literalOf } from './src/pattern.mjs'
export { normalize, tokenize, tokenizePair, fold, swapPerson, fillIn } from './src/text.mjs'
