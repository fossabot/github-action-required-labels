const core = require("@actions/core");
const github = require("@actions/github");

let matchToken;
async function action() {
  // Use a guaranteed-unique (but persistent) string to match "our" comment
  // https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
  const matchTokenId = [
    process.env.GITHUB_WORKFLOW,
    process.env.GITHUB_JOB,
    process.env.GITHUB_ACTION,
  ].join("/");

  matchToken = `<!-- ${matchTokenId} -->\n`;

  try {
    const token = core.getInput("token", { required: true });
    const octokit = github.getOctokit(token);

    // Process inputs for use later
    const mode = core.getInput("mode", { required: true });
    const count = parseInt(core.getInput("count", { required: true }), 10);

    const exitType = core.getInput("exit_type") || "failure";
    const shouldAddComment = core.getInput("add_comment") == "true";
    const labelsAreRegex = core.getInput("use_regex") == "true";

    let providedLabels = core.getInput("labels", { required: true });

    core.debug(`gather labels: ${providedLabels}`);
    if (labelsAreRegex) {
      // If labels are regex they must be provided as new line delimited
      providedLabels = providedLabels.split("\n");
    } else {
      // Comma separated are allowed for exact string matches
      // This may be removed in the next major version
      providedLabels = providedLabels
        .split("\n")
        .join(",")
        .split(",")
        .map((l) => l.trim());
    }

    // Remove any empty labels
    providedLabels = providedLabels.filter((r) => r);

    let issue_number = github.context.issue.number;

    if (github.context.eventName === "merge_group" && !issue_number) {
      // Parse out of the ref for merge queue
      // e.g. refs/heads/gh-readonly-queue/main/pr-17-a3c310584587d4b97c2df0cb46fe050cc46a15d6
      const lastPart = github.context.ref.split("/").pop();
      issue_number = lastPart.match(/pr-(\d+)-/)[1];
      core.info(
        `merge_group event detected and issue_number parsed as ${issue_number}`,
      );
    }

    const allowedModes = ["exactly", "minimum", "maximum"];
    if (!allowedModes.includes(mode)) {
      await exitWithError(
        exitType,
        octokit,
        shouldAddComment,
        `Unknown mode input [${mode}]. Must be one of: ${allowedModes.join(
          ", ",
        )}`,
        issue_number,
      );
      return;
    }

    const allowedExitCodes = ["success", "failure"];
    if (!allowedExitCodes.includes(exitType)) {
      await exitWithError(
        exitType,
        octokit,
        shouldAddComment,
        `Unknown exit_code input [${exitType}]. Must be one of: ${allowedExitCodes.join(
          ", ",
        )}`,
        issue_number,
      );
      return;
    }

    core.debug(`fetch the labels for ${issue_number} using the API`);
    // We use the API rather than read event.json in case earlier steps
    // added a label
    // Use octokit.paginate to fetch all pages of labels
    const labels = await octokit.paginate(
      octokit.rest.issues.listLabelsOnIssue,
      {
        ...github.context.repo,
        issue_number,
      },
    );

    const appliedLabels = labels.map((label) => label.name);

    // How many labels overlap?
    let intersection = [];
    if (labelsAreRegex) {
      intersection = appliedLabels.filter((appliedLabel) =>
        providedLabels.some((providedLabel) =>
          new RegExp(providedLabel, "i").test(appliedLabel),
        ),
      );
    } else {
      const lowerCasedAppliedLabels = appliedLabels.map((label) =>
        label.toLowerCase(),
      );
      intersection = providedLabels.filter((x) =>
        lowerCasedAppliedLabels.includes(x.toLowerCase()),
      );
    }

    core.debug(`detect errors...`);
    let errorMode;
    if (mode === "exactly" && intersection.length !== count) {
      errorMode = "exactly";
    } else if (mode === "minimum" && intersection.length < count) {
      errorMode = "at least";
    } else if (mode === "maximum" && intersection.length > count) {
      errorMode = "at most";
    }

    core.debug(`if so, add a comment (if enabled) and fail the run...`);
    if (errorMode !== undefined) {
      const comment = core.getInput("message");
      const errorMessage = tmpl(comment, {
        mode,
        count,
        errorString: errorMode,
        provided: providedLabels.join(", "),
        applied: appliedLabels.join(", "),
      });

      await exitWithError(
        exitType,
        octokit,
        shouldAddComment,
        errorMessage,
        issue_number,
      );
      return;
    }

    core.debug(`remove the comment if it exists...`);
    if (shouldAddComment) {
      const { data: existing } = await octokit.rest.issues.listComments({
        ...github.context.repo,
        issue_number: issue_number,
      });

      const generatedComment = existing.find((c) =>
        c.body.includes(matchToken),
      );
      if (generatedComment) {
        await octokit.rest.issues.deleteComment({
          ...github.context.repo,
          comment_id: generatedComment.id,
        });
      }
    }

    core.setOutput("labels", intersection.join(","));
    core.setOutput("status", "success");
  } catch (e) {
    core.setFailed(e.message);
  }
}

function tmpl(t, o) {
  return t.replace(/\{\{\s*(.*?)\s*\}\}/g, function (item, param) {
    return o[param];
  });
}

async function exitWithError(
  exitType,
  octokit,
  shouldAddComment,
  message,
  issue_number,
) {
  if (shouldAddComment) {
    // Is there an existing comment?
    const { data: existing } = await octokit.rest.issues.listComments({
      ...github.context.repo,
      issue_number: issue_number,
    });

    const generatedComment = existing.find((c) => c.body.includes(matchToken));

    const params = {
      ...github.context.repo,
      issue_number: issue_number,
      body: `${matchToken}${message}`,
    };

    // If so, update it
    let method = "createComment";
    if (generatedComment) {
      method = "updateComment";
      params.comment_id = generatedComment.id;
    }
    await octokit.rest.issues[method](params);
  }

  core.setOutput("status", "failure");

  if (exitType === "success") {
    core.warning(message);
    return;
  }

  core.setFailed(message);
}

/* istanbul ignore next */
if (require.main === module) {
  action();
}

module.exports = action;
