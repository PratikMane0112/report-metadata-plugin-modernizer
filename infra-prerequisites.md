# Infrastructure Prerequisites

These items are Jenkins infrastructure coordination tasks that require
mentor/infra-team involvement. They are **not** code tasks — each corresponds
to a helpdesk issue that must be filed at
[jenkins-infra/helpdesk](https://github.com/jenkins-infra/helpdesk/issues).

---

## 1. `nodejs-20` tool configuration on `trusted.ci.jenkins.io`

**Suggested issue title:**
> [trusted.ci.jenkins.io] Add `nodejs-20` to Global Tool Configuration (NodeJS plugin)

**Why:** Pipeline A (`Jenkinsfile.fetch-publish`) runs on trusted.ci and uses
`tool name: 'nodejs-20', type: 'nodejs'` to install Node.js for running the
`consolidate.ts` data transformation script. Without this tool configuration,
the `Transform Data` stage will fail.

**Action required:** Add a NodeJS installer named `nodejs-20` pointing to
Node.js 20.x LTS in Jenkins → Manage Jenkins → Global Tool Configuration →
NodeJS installations. This may require a Puppet config PR to
`jenkins-infra/jenkins-infra`.

---

## 2. `nodejs-20` tool configuration on `ci.jenkins.io`

**Suggested issue title:**
> [ci.jenkins.io] Verify/add `nodejs-20` to Global Tool Configuration (NodeJS plugin)

**Why:** Pipeline B (`Jenkinsfile`) runs on ci.jenkins.io for PR and main
branch builds. It uses `tools { nodejs 'nodejs-20' }` in the Declarative
pipeline. This tool name must exist in Global Tool Configuration.

**Action required:** Verify whether `nodejs-20` already exists on ci.jenkins.io.
If not, add it following the same pattern as item 1.

---

## 3. `reports.jenkins.io` subdirectory allocation for `plugin-modernizer-stats`

**Suggested issue title:**
> [reports.jenkins.io] Allocate `/plugin-modernizer-stats/` path for Plugin Modernizer Stats data

**Why:** `infra.publishReports(['plugin-modernizer-stats.zip'])` unpacks the
ZIP to the reports server's document root. The content must be served at
`https://reports.jenkins.io/plugin-modernizer-stats/`. The infra team needs
to acknowledge this path and ensure the server configuration supports it.

**Action required:** The `infra.publishReports()` call in the pipeline-library
manages the unpack target. Confirm with the infra team that no path conflict
exists and that the new subdirectory is acceptable.

---

## 4. `Jenkinsfile.fetch-publish` job registration on `trusted.ci.jenkins.io`

**Suggested issue title:**
> [trusted.ci.jenkins.io] Create pipeline job for `plugin-modernizer-stats` data publishing

**Why:** A new pipeline job must be created on trusted.ci.jenkins.io that
points to the `plugin-modernizer-stats` repository with script path set to
`Jenkinsfile.fetch-publish`. This is separate from the ci.jenkins.io job
(which uses the default `Jenkinsfile`).

**Action required:**
- Create a new Pipeline or Multibranch Pipeline job on trusted.ci.
- Set the repository URL to the `plugin-modernizer-stats` GitHub repo.
- Set the script path to `Jenkinsfile.fetch-publish`.
- This cannot be self-configured by contributors — requires infra team action.

---

## 5. Cron schedule approval

**Suggested issue title:**
> [trusted.ci.jenkins.io] Review cron schedule `H 3 * * *` for plugin-modernizer-stats data pipeline

**Why:** The `Jenkinsfile.fetch-publish` pipeline uses `cron('H 3 * * *')`
to run daily around 3 AM UTC. The `H` hash distributes execution across the
hour to avoid thundering herd, but the infra team should review this to ensure
it does not conflict with other overnight jobs on trusted.ci (e.g.,
`infra-statistics` runs at `0 3 2 * *`, `pipeline-steps-doc-generator` runs
weekly).

**Action required:** Infra team review and approval of the schedule.

---

## 6. PR to `jenkins-infra/pipeline-library` for `publishPluginModernizerStats.groovy`

**Suggested issue title:**
> [pipeline-library] Add `publishPluginModernizerStats` shared library step

**Why:** The `proposed-pipeline-library/vars/publishPluginModernizerStats.groovy`
file in this repository is a draft shared library step that encapsulates the
validation, ZIP creation, and `publishReports()` call. If accepted into the
pipeline-library, it can replace the inline packaging logic in
`Jenkinsfile.fetch-publish`, making the pipeline more maintainable.

**Action required:**
- Open a PR against `jenkins-infra/pipeline-library` with the contents of
  `proposed-pipeline-library/vars/publishPluginModernizerStats.groovy`.
- This PR must go through code review by pipeline-library maintainers.
- Start this conversation early — do not assume it will be merged quickly.
- In the meantime, the inline logic in `Jenkinsfile.fetch-publish` works
  as a self-contained fallback.

---

## Tracking

| # | Item | Status | Helpdesk Issue |
|---|------|--------|----------------|
| 1 | `nodejs-20` on trusted.ci | ⬜ Not filed | — |
| 2 | `nodejs-20` on ci.jenkins.io | ⬜ Not filed | — |
| 3 | `reports.jenkins.io` path allocation | ⬜ Not filed | — |
| 4 | Job registration on trusted.ci | ⬜ Not filed | — |
| 5 | Cron schedule approval | ⬜ Not filed | — |
| 6 | Pipeline-library PR | ⬜ Not filed | — |
