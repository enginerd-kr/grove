// Bun's text loader (`with { type: "text" }`) hands a .md file over as its
// contents; this tells tsc the same story.
declare module "*.md" {
  const text: string;
  export default text;
}
