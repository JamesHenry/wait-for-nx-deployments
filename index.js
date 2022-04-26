// Originally inspired by https://github.com/vanekj/validate-json-action

// @ts-check
import core from "@actions/core";
import github from "@actions/github";

const options = {
  token: core.getInput("github-token"),
  timeout: core.getInput("timeout"),
  interval: core.getInput("interval"),
};

try {
  options.deploymentsToWaitFor = JSON.parse(
    core.getInput("deployments-to-wait-for")
  );
} catch {
  core.setFailed(
    `Could not parse the stringified JSON given for "deployments-to-wait-for", please ensure it is valid JSON`
  );
  process.exit(1);
}

console.log({ deploymentsToWaitFor: options.deploymentsToWaitFor });

waitForDeployments(options)
  .then((successfulDeployments) => {
    const deployments = {};
    for (const successfulDeployment of Object.values(successfulDeployments)) {
      deployments[successfulDeployment.projectName] = successfulDeployment;
    }
    core.setOutput("deployments", JSON.stringify(deployments));
  })
  .catch((error) => {
    core.setFailed(error.message);
  });

async function waitForDeployments(options) {
  const { token, interval } = options;
  const successfulDeployments = {};

  const environmentsToProjectNames = {};
  const allEnvironmentsToWaitFor = [];
  for (const projectName of Object.keys(options.deploymentsToWaitFor)) {
    const environment = options.deploymentsToWaitFor[projectName];
    allEnvironmentsToWaitFor.push(environment);
    environmentsToProjectNames[environment] = projectName;
  }

  const timeout = parseInt(options.timeout, 10) || 300;

  const octokit = github.getOctokit(token, {
    previews: ["ant-man-preview", "flash-preview"],
  });

  const gitHubSha = core.getInput("github-head-sha");

  const params = {
    ...github.context.repo,
    sha: gitHubSha,
  };

  core.info(`Listing all deployments for the current commit: ${gitHubSha}`);

  const start = Date.now();

  while (true) {
    const { data: deployments } = await octokit.rest.repos.listDeployments(
      params
    );
    core.info(`Found ${deployments.length} deployments...`);

    for (const environment of allEnvironmentsToWaitFor) {
      for (const deployment of deployments) {
        if (deployment.environment !== environment) {
          continue;
        }

        core.info(
          `\tGetting statuses for environment deployment for "${environment}", deployment ID = ${deployment.id}...`
        );

        const { data: statuses } = await octokit.request(
          "GET /repos/:owner/:repo/deployments/:deployment/statuses",
          {
            ...github.context.repo,
            deployment: deployment.id,
          }
        );

        core.info(`\tFound ${statuses.length} statuses`);

        const success = statuses.find((status) => status.state === "success");
        if (success) {
          core.info(`\tSuccessful deployment found`);

          let url = success.target_url || success.environment_url;
          const projectName = environmentsToProjectNames[environment];

          successfulDeployments[environment] = {
            projectName,
            environment,
            url,
          };
          continue;
        }

        core.info(
          `\tNo statuses with state === "success": "${statuses
            .map((status) => status.state)
            .join('", "')}"`
        );
      }
    }

    core.info(`Sleeping for ${interval} seconds...`);
    await sleep(interval);

    core.info(
      `Successful deployments so far: ${JSON.stringify(
        successfulDeployments,
        null,
        2
      )}`
    );

    if (allEnvironmentsToWaitFor.every((env) => successfulDeployments[env])) {
      core.info(
        `All environments successfully deployed for the current commit`
      );
      return successfulDeployments;
    }

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed >= timeout) {
      throw new Error(
        `Timing out after ${timeout} seconds (${elapsed} elapsed)`
      );
    }
  }
}

function sleep(seconds) {
  const ms = parseInt(seconds, 10) * 1000 || 5000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
