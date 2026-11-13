import { describe, expect, it } from "vitest";
import {
  isUnknownRepoLabel,
  labelledHead,
  matchesRepoFilter,
  REPO_FILTER_ALL,
  REPO_UNKNOWN_KEY,
  REPO_UNKNOWN_LABEL,
  repoFilterOptions,
  repoLabel,
  repoLabels,
  resolveRepoFilter,
} from "@/lib/ui/repo";

describe("repoLabel / repoLabels", () => {
  it("labels the Brain's own store dir as 'Brain'", () => {
    expect(repoLabel("~/.claude")).toBe("Brain");
    expect(repoLabels(["~/.claude"]).get("~/.claude")).toBe("Brain");
  });

  it("labels an ordinary path by its last segment", () => {
    expect(repoLabel("~/code/sample-app")).toBe("sample-app");
    expect(repoLabel("~/code/sample-app/")).toBe("sample-app"); // trailing slash ignored
  });

  it("disambiguates two DIFFERENT paths that share a last segment with the parent segment", () => {
    const labels = repoLabels(["~/work/apps/api", "~/side/services/api"]);
    expect(labels.get("~/work/apps/api")).toBe("apps/api");
    expect(labels.get("~/side/services/api")).toBe("services/api");
  });

  it("does not disambiguate a basename that is not actually shared", () => {
    const labels = repoLabels(["~/work/apps/api", "~/code/sample-app"]);
    expect(labels.get("~/work/apps/api")).toBe("api");
    expect(labels.get("~/code/sample-app")).toBe("sample-app");
  });

  it("keeps growing until unique when a deeper collision remains after one extra segment", () => {
    // "~/a/x/api" and "~/b/x/api" still collide at "x/api" (one segment up), so both grow once more
    const labels = repoLabels(["~/a/x/api", "~/b/x/api"]);
    expect(labels.get("~/a/x/api")).toBe("a/x/api");
    expect(labels.get("~/b/x/api")).toBe("b/x/api");
    expect(labels.get("~/a/x/api")).not.toBe(labels.get("~/b/x/api"));
  });

  it("gives the same path the same label every time, even across repeats in the list", () => {
    const labels = repoLabels(["~/work/apps/api", "~/work/apps/api", "~/side/services/api"]);
    expect(labels.get("~/work/apps/api")).toBe("apps/api");
    expect(repoLabel("~/work/apps/api", labels)).toBe(repoLabel("~/work/apps/api", labels));
  });

  it("several missions on the same repo share its label", () => {
    const labels = repoLabels(["~/code/sample-app", "~/code/sample-app", "~/other/thing"]);
    expect(labels.get("~/code/sample-app")).toBe("sample-app");
  });

  it("falls back to 'repo unknown' for missing or empty paths", () => {
    expect(repoLabel(null)).toBe(REPO_UNKNOWN_LABEL);
    expect(repoLabel(undefined)).toBe(REPO_UNKNOWN_LABEL);
    expect(repoLabel("")).toBe(REPO_UNKNOWN_LABEL);
    expect(repoLabel("   ")).toBe(REPO_UNKNOWN_LABEL);
    expect(isUnknownRepoLabel(repoLabel(null))).toBe(true);
    expect(isUnknownRepoLabel("sample-app")).toBe(false);
  });

  it("repoLabels ignores missing entries when computing the distinct list", () => {
    const labels = repoLabels(["~/code/sample-app", null, undefined, ""]);
    expect(labels.size).toBe(1);
    expect(labels.get("~/code/sample-app")).toBe("sample-app");
  });

  it("never derives a label from a title: the helper only ever takes a path", () => {
    // repoLabel's signature has no title parameter at all; a path that happens to look like a title
    // string is still labelled purely by its last path segment.
    expect(repoLabel("~/code/Fix the login bug")).toBe("Fix the login bug");
  });

  it("falls back to the path's own standalone label — never 'repo unknown' — when it is missing from the map (R1)", () => {
    // a caller that built its labels map over a different (e.g. empty) list must still get a real label
    expect(repoLabel("~/a/b", repoLabels([]))).toBe("b");
    expect(repoLabel("~/.claude", repoLabels([]))).toBe("Brain");
    const labels = repoLabels(["~/other/repo"]); // "~/a/b" is not in this map at all
    expect(repoLabel("~/a/b", labels)).toBe("b");
  });

  it("labelledHead labels the shown head over the WHOLE list, so a short view agrees with the full views (R2)", () => {
    // the colliding sibling is outside the head: labelling only the head would give a bare "api"
    const tasks = [{ repository: "~/work/apps/api" }, { repository: "~/side/services/api" }, { repository: "~/code/sample-app" }];
    const { head, labels } = labelledHead(tasks, 1);
    expect(head).toEqual([tasks[0]]);
    expect(repoLabel(head[0]!.repository, labels)).toBe("apps/api");
    expect(repoLabel(head[0]!.repository, labels)).toBe(repoLabel(head[0]!.repository, repoLabels(tasks.map((t) => t.repository))));
  });
});

describe("repoFilterOptions / matchesRepoFilter / resolveRepoFilter", () => {
  it("lists 'All' plus the distinct labels, sorted, with 'repo unknown' last when present", () => {
    const paths = ["~/code/sample-app", "~/.claude", "~/code/sample-app", null];
    const labels = repoLabels(paths);
    const options = repoFilterOptions(paths, labels);
    expect(options.map((o) => o.label)).toEqual(["All", "Brain", "sample-app", REPO_UNKNOWN_LABEL]);
    expect(options.map((o) => o.key)).toEqual([REPO_FILTER_ALL, "~/.claude", "~/code/sample-app", REPO_UNKNOWN_KEY]);
  });

  it("omits 'repo unknown' when no mission is missing a repository", () => {
    const paths = ["~/code/sample-app", "~/.claude"];
    const options = repoFilterOptions(paths, repoLabels(paths));
    expect(options.map((o) => o.label)).toEqual(["All", "Brain", "sample-app"]);
  });

  it("keys options by path, so two repos with similar labels never collide in the filter (R3a/b)", () => {
    const paths = ["~/a/x/api", "~/b/x/api"];
    const labels = repoLabels(paths);
    const options = repoFilterOptions(paths, labels);
    const keys = options.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate keys, even before full disambiguation elsewhere
    expect(matchesRepoFilter("~/a/x/api", "~/a/x/api")).toBe(true);
    expect(matchesRepoFilter("~/b/x/api", "~/a/x/api")).toBe(false);
  });

  it("a repository literally named 'All' does not collide with the All option (R3b)", () => {
    const paths = ["~/code/All"];
    const options = repoFilterOptions(paths, repoLabels(paths));
    const allOption = options.find((o) => o.label === "All" && o.key === REPO_FILTER_ALL);
    const namedAll = options.find((o) => o.key === "~/code/All");
    expect(allOption).toBeDefined();
    expect(namedAll).toBeDefined();
    expect(allOption?.key).not.toBe(namedAll?.key);
    const keys = options.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches everything under REPO_FILTER_ALL, unknown repos under REPO_UNKNOWN_KEY, and only the exact path otherwise", () => {
    expect(matchesRepoFilter("~/code/sample-app", REPO_FILTER_ALL)).toBe(true);
    expect(matchesRepoFilter(null, REPO_FILTER_ALL)).toBe(true);
    expect(matchesRepoFilter(null, REPO_UNKNOWN_KEY)).toBe(true);
    expect(matchesRepoFilter("", REPO_UNKNOWN_KEY)).toBe(true);
    expect(matchesRepoFilter("~/code/sample-app", REPO_UNKNOWN_KEY)).toBe(false);
    expect(matchesRepoFilter("~/code/sample-app", "~/code/sample-app")).toBe(true);
    expect(matchesRepoFilter("~/code/sample-app", "~/code/other")).toBe(false);
  });

  it("resets a vanished selection back to All (R3c)", () => {
    const options = repoFilterOptions(["~/code/sample-app"], repoLabels(["~/code/sample-app"]));
    expect(resolveRepoFilter("~/code/sample-app", options)).toBe("~/code/sample-app");
    // the mission for that repo is gone from the next poll's list
    const next = repoFilterOptions(["~/other/repo"], repoLabels(["~/other/repo"]));
    expect(resolveRepoFilter("~/code/sample-app", next)).toBe(REPO_FILTER_ALL);
  });
});
