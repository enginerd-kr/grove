/**
 * Dice that fall the same way every time, so a re-shot README differs where
 * the UI changed and nowhere else.
 *
 * The banner draws its tip at random on mount — see `LIST_TIPS` in
 * `Banner.tsx` — and a picture is checked byte for byte against a re-shoot on a
 * machine nobody chose. A draw that can land on any of ten lines is a check
 * that passes one time in ten, which is a check that fails. So the draw is
 * pinned here, in the one script that needs it, for the reason `clock.ts`
 * pins the clock: threading a seed through the app would be a seam that
 * exists for the screenshots and for nothing else.
 *
 * Not a constant. `anotherPick` draws again until it lands somewhere new, and
 * a die that always showed the same face would spin it forever. This one
 * counts up through ten faces and comes back round, so the first draw is the
 * first tip — which is the line the committed pictures already show — and
 * every draw after it is a different one.
 *
 * Every shot mounts a banner of its own, and each mount is a draw — so the
 * count is put back before each shot, or the second picture would show the
 * second tip and the third the third.
 */

/** How many faces, which is one per tip in the list screen's pool. */
const FACES = 10;

let rolls = 0;

Math.random = () => (rolls++ % FACES) / FACES;

/** Back to the first face, for the next shot's banner. */
export function resetDice(): void {
  rolls = 0;
}
