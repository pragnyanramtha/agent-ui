/** Stands in for rehype-raw in the browser bundle (aliased in next.config.ts). Markdown here never renders raw
 * HTML, so the plugin Streamdown imports for its defaults is never used and its HTML parser needn't ship. */
export default function rehypeRaw() {}
