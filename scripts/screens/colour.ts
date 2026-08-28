/**
 * Colour, with nothing attached to stdout.
 *
 * The shots are drawn onto a fake screen, so chalk — and every colour Ink asks
 * it for — would otherwise decide there is no terminal to paint and hand back
 * bare text. A picture of the UI in monochrome is a picture of a different
 * program, so this is imported first, before Ink and chalk are pulled in and
 * read it.
 */
process.env.FORCE_COLOR = "3";
