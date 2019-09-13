const {pick} = require('lodash');
const marked = require('marked');
const TerminalRenderer = require('marked-terminal');
const envCi = require('env-ci');
const hookStd = require('hook-std');
const pEachSeries = require('p-each-series');
const semver = require('semver');
const AggregateError = require('aggregate-error');
const pkg = require('./package.json');
const hideSensitive = require('./lib/hide-sensitive');
const getConfig = require('./lib/get-config');
const verify = require('./lib/verify');
const getNextVersion = require('./lib/get-next-version');
const getCommits = require('./lib/get-commits');
const getLastRelease = require('./lib/get-last-release');
const getReleasesToAdd = require('./lib/get-releases-to-add');
const {extractErrors, makeTag} = require('./lib/utils');
const getGitAuthUrl = require('./lib/get-git-auth-url');
const getBranches = require('./lib/branches');
const getLogger = require('./lib/get-logger');
const {verifyAuth, isBranchUpToDate, getGitHead, tag, push} = require('./lib/git');
const getError = require('./lib/get-error');
const {COMMIT_NAME, COMMIT_EMAIL} = require('./lib/definitions/constants');

marked.setOptions({renderer: new TerminalRenderer()});

/* eslint complexity: ["warn", 25] */
async function run(context, plugins) {
  const {cwd, env, options, logger} = context;
  const {isCi, branch: ciBranch, isPr} = envCi({env, cwd});

  if (!isCi && !options.dryRun && !options.noCi) {
    logger.warn('This run was not triggered in a known CI environment, running in dry-run mode.');
    options.dryRun = true;
  } else {
    // When running on CI, set the commits author and commiter info and prevent the `git` CLI to prompt for username/password. See #703.
    Object.assign(env, {
      GIT_AUTHOR_NAME: COMMIT_NAME,
      GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
      GIT_COMMITTER_NAME: COMMIT_NAME,
      GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
      ...env,
      GIT_ASKPASS: 'echo',
      GIT_TERMINAL_PROMPT: 0,
    });
  }

  if (isCi && isPr && !options.noCi) {
    logger.log("This run was triggered by a pull request and therefore a new version won't be published.");
    return false;
  }

  // Verify config
  await verify(context);

  options.repositoryUrl = await getGitAuthUrl(context);
  context.branches = await getBranches(options.repositoryUrl, context);
  context.branch = context.branches.find(({name}) => name === ciBranch);

  if (!context.branch) {
    logger.log(
      `This test run was triggered on the branch ${ciBranch}, while semantic-release is configured to only publish from ${context.branches
        .map(({name}) => name)
        .join(', ')}, therefore a new version won’t be published.`
    );
    return false;
  }

  logger[options.dryRun ? 'warn' : 'success'](
    `Run automated release from branch ${ciBranch}${options.dryRun ? ' in dry-run mode' : ''}`
  );

  try {
    try {
      await verifyAuth(options.repositoryUrl, context.branch.name, {cwd, env});
    } catch (error) {
      if (!(await isBranchUpToDate(options.repositoryUrl, context.branch.name, {cwd, env}))) {
        logger.log(
          `The local branch ${context.branch.name} is behind the remote one, therefore a new version won't be published.`
        );
        return false;
      }

      throw error;
    }
  } catch (error) {
    logger.error(`The command "${error.cmd}" failed with the error message ${error.stderr}.`);
    throw getError('EGITNOPERMISSION', context);
  }

  logger.success(`Allowed to push to the Git repository`);

  await plugins.verifyConditions(context);

  const releasesToAdd = getReleasesToAdd(context);
  const errors = [];
  context.releases = [];

  await pEachSeries(releasesToAdd, async ({lastRelease, currentRelease, nextRelease}) => {
    if (context.branch.mergeRange && !semver.satisfies(nextRelease.version, context.branch.mergeRange)) {
      errors.push(getError('EINVALIDMAINTENANCEMERGE', {...context, nextRelease}));
      return;
    }

    const commits = await getCommits({...context, lastRelease, nextRelease});
    nextRelease.notes = await plugins.generateNotes({...context, commits, lastRelease, nextRelease});

    logger.log('Create tag %s', nextRelease.gitTag);
    await tag(nextRelease.gitTag, nextRelease.gitHead, {cwd, env});
    await push(options.repositoryUrl, {cwd, env});
    context.branch.tags.push({
      version: nextRelease.version,
      channel: nextRelease.channel,
      gitTag: nextRelease.gitTag,
      gitHead: nextRelease.gitHead,
    });

    const releases = await plugins.addChannel({...context, commits, lastRelease, currentRelease, nextRelease});
    context.releases.push(...releases);
    await plugins.success({...context, lastRelease, commits, nextRelease, releases});
  });

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  context.lastRelease = await getLastRelease(context);

  if (context.lastRelease.gitTag) {
    logger.log(
      `Found git tag ${context.lastRelease.gitTag} associated with version ${context.lastRelease.version} on branch ${context.branch.name}`
    );
  } else {
    logger.log(`No git tag version found on branch ${context.branch.name}`);
  }

  context.commits = await getCommits(context);

  const nextRelease = {
    type: await plugins.analyzeCommits(context),
    channel: context.branch.channel,
    gitHead: await getGitHead({cwd, env}),
  };
  if (!nextRelease.type) {
    logger.log('There are no relevant changes, so no new version is released.');
    return context.releases.length > 0 ? {releases: context.releases} : false;
  }

  context.nextRelease = nextRelease;
  nextRelease.version = getNextVersion(context);
  nextRelease.gitTag = makeTag(options.tagFormat, nextRelease.version, nextRelease.channel);
  nextRelease.name = makeTag(options.tagFormat, nextRelease.version);

  if (context.branch.type !== 'prerelease' && !semver.satisfies(nextRelease.version, context.branch.range)) {
    throw getError('EINVALIDNEXTVERSION', {
      ...context,
      validBranches: context.branches.filter(
        ({type, accept}) => type !== 'prerelease' && accept.includes(nextRelease.type)
      ),
    });
  }

  await plugins.verifyRelease(context);

  nextRelease.notes = await plugins.generateNotes(context);

  await plugins.prepare(context);

  if (options.dryRun) {
    logger.warn(`Skip ${nextRelease.gitTag} tag creation in dry-run mode`);
  } else {
    // Create the tag before calling the publish plugins as some require the tag to exists
    await tag(nextRelease.gitTag, nextRelease.gitHead, {cwd, env});
    await push(options.repositoryUrl, {cwd, env});
    logger.success(`Created tag ${nextRelease.gitTag}`);
  }

  const releases = await plugins.publish(context);
  context.releases.push(...releases);

  await plugins.success({...context, releases});

  logger.success(`Published release ${nextRelease.version}`);

  if (options.dryRun) {
    logger.log(`Release note for version ${nextRelease.version}:`);
    if (nextRelease.notes) {
      context.stdout.write(marked(nextRelease.notes));
    }
  }

  return pick(context, ['lastRelease', 'commits', 'nextRelease', 'releases']);
}

function logErrors({logger, stderr}, err) {
  const errors = extractErrors(err).sort(error => (error.semanticRelease ? -1 : 0));
  for (const error of errors) {
    if (error.semanticRelease) {
      logger.error(`${error.code} ${error.message}`);
      if (error.details) {
        stderr.write(marked(error.details));
      }
    } else {
      logger.error('An error occurred while running semantic-release: %O', error);
    }
  }
}

async function callFail(context, plugins, err) {
  const errors = extractErrors(err).filter(err => err.semanticRelease);
  if (errors.length > 0) {
    try {
      await plugins.fail({...context, errors});
    } catch (error) {
      logErrors(context, error);
    }
  }
}

module.exports = async (opts = {}, {cwd = process.cwd(), env = process.env, stdout, stderr} = {}) => {
  const {unhook} = hookStd(
    {silent: false, streams: [process.stdout, process.stderr, stdout, stderr].filter(Boolean)},
    hideSensitive(env)
  );
  const context = {cwd, env, stdout: stdout || process.stdout, stderr: stderr || process.stderr};
  context.logger = getLogger(context);
  context.logger.log(`Running ${pkg.name} version ${pkg.version}`);
  try {
    const {plugins, options} = await getConfig(context, opts);
    context.options = options;
    try {
      const result = await run(context, plugins);
      unhook();
      return result;
    } catch (error) {
      await callFail(context, plugins, error);
      throw error;
    }
  } catch (error) {
    logErrors(context, error);
    unhook();
    throw error;
  }
};
