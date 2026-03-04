#!/usr/bin/env groovy

/**
 * publishPluginModernizerStats.groovy
 *
 * Proposed shared library step for jenkins-infra/pipeline-library.
 * Encapsulates validation, ZIP creation, and the publishReports call
 * for publishing plugin-modernizer stats to reports.jenkins.io.
 *
 * Usage in Jenkinsfile.fetch-publish:
 *   publishPluginModernizerStats(sourceDir: 'plugin-modernizer-stats')
 *
 * Parameters:
 *   sourceDir (required): path to the transformed output directory
 *   zipName   (optional): override ZIP filename (default: 'plugin-modernizer-stats.zip')
 *
 * Behavior:
 *   - Validates required files exist in sourceDir before packaging
 *   - Creates a ZIP with sourceDir/ as the root directory
 *   - On trusted.ci.jenkins.io: publishes via infra.publishReports()
 *   - On other controllers/PRs: archives the ZIP as a build artifact
 *
 * Reference:
 *   - jenkins-infra/pipeline-steps-doc-generator/Jenkinsfile (publishReports pattern)
 *   - jenkins-infra/infra-statistics/Jenkinsfile (isTrusted gate)
 */
def call(Map params = [:]) {
    def sourceDir = params.sourceDir ?: error('publishPluginModernizerStats: sourceDir is required')
    def zipName   = params.zipName   ?: 'plugin-modernizer-stats.zip'

    // Validate required files exist before packaging
    def requiredFiles = [
        "${sourceDir}/summary.json",
        "${sourceDir}/manifest.json",
        "${sourceDir}/plugin-recipes-index.json",
    ]
    requiredFiles.each { filePath ->
        if (!fileExists(filePath)) {
            error("publishPluginModernizerStats: Required file missing before packaging: ${filePath}")
        }
    }

    // Create the ZIP with sourceDir/ as the root directory inside the archive
    sh "rm -f ${zipName} && zip -r ${zipName} ${sourceDir}/"

    // Log ZIP summary for build inspection
    sh "echo 'ZIP size:' && du -sh ${zipName} && echo 'ZIP entries (first 20):' && unzip -l ${zipName} | head -20"

    // Gate on trusted environment
    if (infra.isTrusted()) {
        infra.publishReports([zipName])
        echo "publishPluginModernizerStats: Published ${zipName} to reports.jenkins.io"
    } else {
        archiveArtifacts artifacts: zipName, fingerprint: true
        echo "publishPluginModernizerStats: Non-trusted build, artifact archived locally."
    }
}
