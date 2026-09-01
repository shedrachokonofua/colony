/**
 * Shared reader for every `<file|->` argument: a file path, or `-` for all
 * of stdin. The implementation landed with slice 0's input reader.
 */
export { readTextInput as readText } from "./input.js";