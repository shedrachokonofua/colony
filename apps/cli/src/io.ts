/**
 * Shared reader for every `<file|->` argument: a file path, or `-` meaning
 * read all of stdin, so `open -` and `--feedback -` compose with pipes.
 */
export { readTextInput as readText } from "./input.js";
