import { createHash } from "node:crypto";

function sha256Digest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function buildDescriptionDigest(finding) {
  // Plan §17.1.1: finding may expose description/suggestion alongside the
  // legacy detail/recommendation. Fold both into the digest so dedup still
  // collapses the same problem whether the reviewer used rich or legacy shape.
  const body = [
    finding.detail ?? "",
    finding.description ?? "",
    finding.suggestion ?? "",
    finding.title ?? ""
  ]
    .map((segment) => segment.trim().replace(/\s+/g, " "))
    .join("|");
  return finding.descriptionDigest || sha256Digest(body);
}

function findingKey(finding) {
  const file = finding.filePath || finding.artifact || "(unknown)";
  const range = Array.isArray(finding.lineRange) ? finding.lineRange.join("-") : "";
  const category = finding.category || finding.title || "(uncategorized)";
  const digest = buildDescriptionDigest(finding);
  return `${file}|${range}|${category}|${digest}`;
}

function coerceVerdictLabel(entry) {
  // Plan §17.1.1: judgement.label is the authoritative verdict when present.
  if (entry && entry.judgement && entry.judgement.label) return entry.judgement.label;
  return entry?.verdict;
}

export function dedupeFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...finding, mergedFrom: finding.reviewer ? [finding.reviewer] : [] });
      continue;
    }
    if (finding.reviewer && !existing.mergedFrom.includes(finding.reviewer)) {
      existing.mergedFrom.push(finding.reviewer);
    }
  }
  return [...groups.values()];
}

function coverageGap(verdict, requiredArtifacts) {
  if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length === 0) {
    return [];
  }
  const touched = Array.isArray(verdict.touched_files) ? new Set(verdict.touched_files) : new Set();
  return requiredArtifacts.filter((artifact) => !touched.has(artifact));
}

export function downgradeVerdictsForCoverage(verdicts, requiredArtifacts) {
  const out = [];
  for (const verdict of verdicts) {
    const uncovered = coverageGap(verdict, requiredArtifacts);
    if (verdict.verdict === "GREEN" && uncovered.length > 0) {
      const downgraded = {
        ...verdict,
        verdict: "YELLOW",
        coverageComplete: false,
        findings: [
          ...(verdict.findings || []),
          {
            id: `FIND-COV-${verdict.reviewer || verdict.reviewerId || "anon"}`,
            severity: "high",
            category: "coverage_incomplete",
            filePath: "(aggregator)",
            lineRange: [0, 0],
            title: "coverage_incomplete",
            detail: `Reviewer claimed GREEN but did not read: ${uncovered.join(", ")}`,
            recommendation: "Re-run review with full artifact coverage.",
            reviewer: verdict.reviewer
          }
        ]
      };
      out.push(downgraded);
    } else {
      out.push(verdict);
    }
  }
  return out;
}

export function computeQuorum(reviewerCount) {
  return Math.max(1, Math.ceil(reviewerCount * 2 / 3));
}

export function aggregateVerdicts(verdicts, options = {}) {
  const { requiredArtifacts = [], manifestReviewerCount = null } = options;
  const adjusted = downgradeVerdictsForCoverage(verdicts, requiredArtifacts).map((entry) => ({
    ...entry,
    verdict: coerceVerdictLabel(entry)
  }));
  const present = adjusted.filter((verdict) => verdict.verdict && verdict.verdict !== "PENDING");
  const eligible = present.filter((verdict) => verdict.coverageComplete !== false);
  const ineligible = present.filter((verdict) => verdict.coverageComplete === false);
  const counts = {
    GREEN: eligible.filter((v) => v.verdict === "GREEN").length,
    YELLOW: eligible.filter((v) => v.verdict === "YELLOW").length,
    RED: eligible.filter((v) => v.verdict === "RED").length
  };
  const reviewerCount =
    typeof manifestReviewerCount === "number" && manifestReviewerCount > 0
      ? manifestReviewerCount
      : verdicts.length;
  const quorum = computeQuorum(reviewerCount);

  let verdict;
  if (eligible.length === 0) {
    verdict = "RED";
  } else if (eligible.length < quorum) {
    verdict = "INCONCLUSIVE";
  } else if (counts.RED > 0) {
    verdict = "RED";
  } else if (counts.YELLOW > 0) {
    verdict = "YELLOW";
  } else {
    verdict = "GREEN";
  }

  const findingsFromVerdicts = adjusted.flatMap((entry) =>
    (entry.findings || []).map((finding) => ({ reviewer: entry.reviewer, ...finding }))
  );
  const syntheticFindings = ineligible.map((verdictEntry) => ({
    reviewer: verdictEntry.reviewer,
    id: `FIND-COV-META-${verdictEntry.reviewer || verdictEntry.reviewerId || "anon"}`,
    severity: "medium",
    title: "coverage_incomplete",
    detail:
      "This reviewer result was excluded from final quorum because coverageComplete=false.",
    artifact: "review_meta",
    category: "coverage_incomplete",
    recommendation: "Rerun the excluded reviewer with a complete artifact set."
  }));
  const allFindings = [...syntheticFindings, ...findingsFromVerdicts];
  const findings = dedupeFindings(allFindings);

  return {
    verdict,
    reviewerCount: verdicts.length,
    countedReviewerCount: eligible.length,
    coverageComplete: ineligible.length === 0 && verdicts.length > 0,
    counts,
    quorum,
    findings
  };
}
