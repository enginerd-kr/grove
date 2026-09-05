import type { WorktreeSummary } from "../../core/commands/list.ts";
import type { PullRequest } from "../../core/commands/pr.ts";
import type { RebaseChoice } from "../../core/commands/rebase.ts";
import type { Pending } from "./pending.ts";
import type { Prompt } from "./typing.ts";

export type Mode =
  | { readonly kind: "list" }
  /**
   * `from` is the branch the new one starts on, taken from wherever the cursor
   * was when the prompt opened — not from wherever it is when you press enter.
   * The list re-reads itself on a timer, and a base that could change while you
   * were still typing the name would be a different branch than the one the
   * prompt said.
   */
  | ({ readonly kind: "add"; readonly from?: string } & Prompt)
  /** `/upstream`: the URL being typed. Nothing else is carried; the trunk is read when it runs. */
  | ({ readonly kind: "upstream" } & Prompt)
  | { readonly kind: "confirm"; readonly target: Pending }
  /**
   * The open pull requests, and which one the cursor is on.
   *
   * The rows are read before the popup opens rather than while it is up, for
   * the same reason `add` carries its base: a list that filled itself in under
   * the cursor would move what `enter` is aimed at.
   */
  | { readonly kind: "pick"; readonly prs: readonly PullRequest[]; readonly index: number }
  /**
   * `/rebase`'s popup: the bases for one row, and which the cursor is on.
   *
   * The row is carried the way `add` carries its base, and the choices the
   * way `pick` carries its rows: both were read when the popup opened, and a
   * list re-read under the cursor would move what `enter` is aimed at.
   */
  | {
      readonly kind: "onto";
      readonly summary: WorktreeSummary;
      readonly choices: readonly RebaseChoice[];
      readonly index: number;
    }
  /**
   * The slash menu: everything the list can do that has no key of its own.
   *
   * The rows are *not* carried here, unlike `pick`'s. They are a constant
   * narrowed by `query`, so holding them would be holding a derivation — and
   * the one thing they depend on besides the query, `logOn`, is changed only
   * by running the command that closes the menu.
   *
   * `index` counts into what the query matched rather than into every command,
   * which is why every edit to `query` puts it back to 0: a cursor left on the
   * fourth row of a list that is now one row long is aimed at nothing.
   */
  | { readonly kind: "menu"; readonly query: string; readonly index: number }
  | { readonly kind: "busy"; readonly label: string };
