import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  createLocalBashOperations,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
  sanitizeProjectCommandEnvironment,
} = await createJiti(import.meta.url).import("./project-command-env.ts");

const HOST_ENVIRONMENT = {
  PORT: "30141",
  NODE_ENV: "production",
  NEXT_RUNTIME: "nodejs",
  NEXT_PRIVATE_WORKER: "1",
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/pi",
  SHELL: "/bin/bash",
  LANG: "en_US.UTF-8",
  LC_ALL: "C.UTF-8",
  HTTPS_PROXY: "http://proxy.example",
  NO_PROXY: "localhost",
  OPENROUTER_API_KEY: "secret",
  GITHUB_TOKEN: "token-secret",
  PI_WEB_PASSWORD: "password-secret",
  PIHUB_AUTH_SECRET: "auth-secret",
  PI_USER_SETTING: "not-allow-listed",
  PI_SESSION_ID: "session-484",
  PI_SESSION_FILE: "/home/pi/.pi/session.jsonl",
  PI_PROVIDER: "provider-id",
  PI_MODEL: "model-id",
  PI_REASONING_LEVEL: "high",
};

test("constructs a minimal project environment using platform casing rules", () => {
  assert.deepEqual(
    sanitizeProjectCommandEnvironment(HOST_ENVIRONMENT, "linux"),
    {
      PATH: HOST_ENVIRONMENT.PATH,
      HOME: HOST_ENVIRONMENT.HOME,
      SHELL: HOST_ENVIRONMENT.SHELL,
      LANG: HOST_ENVIRONMENT.LANG,
      LC_ALL: HOST_ENVIRONMENT.LC_ALL,
      PI_SESSION_ID: HOST_ENVIRONMENT.PI_SESSION_ID,
      PI_SESSION_FILE: HOST_ENVIRONMENT.PI_SESSION_FILE,
      PI_PROVIDER: HOST_ENVIRONMENT.PI_PROVIDER,
      PI_MODEL: HOST_ENVIRONMENT.PI_MODEL,
      PI_REASONING_LEVEL: HOST_ENVIRONMENT.PI_REASONING_LEVEL,
    },
  );
  assert.deepEqual(
    sanitizeProjectCommandEnvironment(
      {
        Port: "30141",
        node_env: "production",
        Next_Runtime: "nodejs",
        NEXT_PUBLIC_FLAG: "1",
        Path: "C:\\Windows",
        systemroot: "C:\\Windows",
        userprofile: "C:\\Users\\Pi",
        temp: "C:\\Temp",
        pi_session_id: "session-windows",
        OpenAI_Api_Key: "secret",
      },
      "win32",
    ),
    {
      Path: "C:\\Windows",
      systemroot: "C:\\Windows",
      userprofile: "C:\\Users\\Pi",
      temp: "C:\\Temp",
      pi_session_id: "session-windows",
    },
  );
  assert.deepEqual(
    sanitizeProjectCommandEnvironment(
      {
        PORT: "30141",
        Port: "project-value",
        NODE_ENV: "production",
        node_env: "project-mode",
        NEXT_RUNTIME: "nodejs",
        Next_Runtime: "project-runtime",
      },
      "linux",
    ),
    {},
  );
});

test("agent bash keeps SDK metadata without exposing host secret canaries", async () => {
  const injectedEnvironment = {
    PORT: "30141",
    NODE_ENV: "production",
    NEXT_RUNTIME: "nodejs",
    NEXT_PRIVATE_WORKER: "1",
    PI_USER_SETTING: "not-allow-listed",
    PI_WEB_PASSWORD: "web-password-canary",
    PIHUB_AUTH_SECRET: "auth-canary",
    OPENROUTER_API_KEY: "api-key-canary",
    GITHUB_TOKEN: "token-canary",
    HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.invalid",
    NO_PROXY: "localhost",
  };
  const original = Object.fromEntries(
    Object.keys(injectedEnvironment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    ...injectedEnvironment,
  });

  try {
    const extension = createProjectCommandBashExtension({
      cwd: process.cwd(),
      settings: {
        getShellCommandPrefix: () => undefined,
        getShellPath: () => undefined,
      },
    });
    let registeredTool;
    await extension.factory({
      registerTool(tool) {
        registeredTool = tool;
      },
    });

    const result = await registeredTool.execute(
      "issue-484",
      {
        command: `node -e 'console.log(JSON.stringify({PORT:process.env.PORT,NODE_ENV:process.env.NODE_ENV,NEXT_RUNTIME:process.env.NEXT_RUNTIME,NEXT_PRIVATE_WORKER:process.env.NEXT_PRIVATE_WORKER,PI_USER_SETTING:process.env.PI_USER_SETTING,PI_WEB_PASSWORD:process.env.PI_WEB_PASSWORD,PIHUB_AUTH_SECRET:process.env.PIHUB_AUTH_SECRET,OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,GITHUB_TOKEN:process.env.GITHUB_TOKEN,HTTPS_PROXY:process.env.HTTPS_PROXY,NO_PROXY:process.env.NO_PROXY,PI_SESSION_ID:process.env.PI_SESSION_ID,PATH:process.env.PATH,HOME:process.env.HOME}))'`,
      },
      undefined,
      undefined,
      {
        model: undefined,
        thinkingLevel: "off",
        sessionManager: {
          getSessionId: () => "session-484",
          getSessionFile: () => undefined,
        },
      },
    );
    const childEnvironment = JSON.parse(result.content[0].text);

    assert.equal(childEnvironment.PORT, undefined);
    assert.equal(childEnvironment.NODE_ENV, undefined);
    assert.equal(childEnvironment.NEXT_RUNTIME, undefined);
    assert.equal(childEnvironment.NEXT_PRIVATE_WORKER, undefined);
    assert.equal(childEnvironment.PI_USER_SETTING, undefined);
    assert.equal(childEnvironment.PI_WEB_PASSWORD, undefined);
    assert.equal(childEnvironment.PIHUB_AUTH_SECRET, undefined);
    assert.equal(childEnvironment.OPENROUTER_API_KEY, undefined);
    assert.equal(childEnvironment.GITHUB_TOKEN, undefined);
    assert.equal(childEnvironment.HTTPS_PROXY, undefined);
    assert.equal(childEnvironment.NO_PROXY, undefined);
    assert.equal(childEnvironment.PI_SESSION_ID, "session-484");
    assert.equal(childEnvironment.HOME, process.env.HOME);
    assert.ok(childEnvironment.PATH.split(delimiter).includes(join(getAgentDir(), "bin")));
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("agent bash reads current shell settings for every execution", async () => {
  let commandPrefix = "export PI_WEB_PREFIX=first";
  const extension = createProjectCommandBashExtension({
    cwd: process.cwd(),
    settings: {
      getShellCommandPrefix: () => commandPrefix,
      getShellPath: () => undefined,
    },
  });
  let registeredTool;
  await extension.factory({
    registerTool(tool) {
      registeredTool = tool;
    },
  });
  const execute = () => registeredTool.execute(
    "settings-reload",
    { command: "printf %s \"$PI_WEB_PREFIX\"" },
    undefined,
    undefined,
    undefined,
  );

  assert.equal((await execute()).content[0].text, "first");
  commandPrefix = "export PI_WEB_PREFIX=second";
  assert.equal((await execute()).content[0].text, "second");
});

test("direct bash removes host secrets and allows explicit project values", async () => {
  const agentBinDir = join(process.cwd(), ".test-agent", "bin");
  const operations = createProjectCommandBashOperations({
    agentBinDir,
    baseEnvironment: {
      ...HOST_ENVIRONMENT,
      PATH: process.env.PATH,
      PI_SESSION_ID: "stale-host-value",
    },
    localOperations: createLocalBashOperations(),
  });
  let output = "";

  await operations.exec(
    `NODE_ENV=test PORT=3200 node -e 'console.log(JSON.stringify({PORT:process.env.PORT,NODE_ENV:process.env.NODE_ENV,NEXT_RUNTIME:process.env.NEXT_RUNTIME,PI_USER_SETTING:process.env.PI_USER_SETTING,PI_WEB_PASSWORD:process.env.PI_WEB_PASSWORD,OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,HTTPS_PROXY:process.env.HTTPS_PROXY,PATH:process.env.PATH}))'`,
    process.cwd(),
    { onData: (chunk) => { output += chunk.toString(); } },
  );
  const childEnvironment = JSON.parse(output);

  assert.equal(childEnvironment.PORT, "3200");
  assert.equal(childEnvironment.NODE_ENV, "test");
  assert.equal(childEnvironment.NEXT_RUNTIME, undefined);
  assert.equal(childEnvironment.PI_USER_SETTING, undefined);
  assert.equal(childEnvironment.PI_WEB_PASSWORD, undefined);
  assert.equal(childEnvironment.OPENROUTER_API_KEY, undefined);
  assert.equal(childEnvironment.HTTPS_PROXY, undefined);
  assert.ok(childEnvironment.PATH.split(delimiter).includes(agentBinDir));
});

test("direct bash preserves execution controls and streaming callbacks", async () => {
  const signal = new AbortController().signal;
  let received;
  let streamed = "";
  const operations = createProjectCommandBashOperations({
    baseEnvironment: HOST_ENVIRONMENT,
    localOperations: {
      async exec(command, cwd, options) {
        received = { command, cwd, options };
        options.onData(Buffer.from("streamed"));
        return { exitCode: 0 };
      },
    },
  });

  await operations.exec("echo ready", "/project", {
    onData: (chunk) => { streamed += chunk.toString(); },
    signal,
    timeout: 12,
  });

  assert.equal(received.command, "echo ready");
  assert.equal(received.cwd, "/project");
  assert.equal(received.options.signal, signal);
  assert.equal(received.options.timeout, 12);
  assert.equal(streamed, "streamed");
});

async function captureOperationEnvironment(options) {
  let environment;
  const operations = createProjectCommandBashOperations({
    ...options,
    localOperations: {
      async exec(_command, _cwd, executionOptions) {
        environment = executionOptions.env;
        return { exitCode: 0 };
      },
    },
  });
  await operations.exec("echo ready", "/project", {
    onData() {},
  });
  return environment;
}

test("direct bash updates the platform PATH key", async () => {
  const agentBinDir = join(process.cwd(), ".test-agent", "bin");
  const cases = [
    {
      options: { agentBinDir, baseEnvironment: { Path: "project-metadata", PATH: "/usr/bin" }, platform: "linux" },
      expected: { PATH: `${agentBinDir}${delimiter}/usr/bin` },
    },
    {
      options: { agentBinDir: "C:\\pi-agent\\bin", baseEnvironment: { Path: "C:\\Windows" }, platform: "win32" },
      expected: { Path: "C:\\pi-agent\\bin;C:\\Windows" },
    },
    {
      options: {
        agentBinDir: "C:\\pi-agent\\bin",
        baseEnvironment: { Path: "c:\\PI-AGENT\\BIN;C:\\Windows" },
        platform: "win32",
      },
      expected: { Path: "c:\\PI-AGENT\\BIN;C:\\Windows" },
    },
    {
      options: { agentBinDir: "C:\\pi-agent\\bin", baseEnvironment: { SystemRoot: "C:\\Windows" }, platform: "win32" },
      expected: { SystemRoot: "C:\\Windows", Path: "C:\\pi-agent\\bin" },
    },
  ];

  for (const { options, expected } of cases) {
    assert.deepEqual(await captureOperationEnvironment(options), expected);
  }
});

test("a user extension keeps priority over the Pi Web fallback bash tool", async () => {
  const userBash = {
    name: "user-bash",
    factory: (pi) => {
      pi.registerTool({
        name: "bash",
        label: "user bash",
        description: "user override",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "user override" }], details: undefined };
        },
      });
    },
  };
  const hostBash = createProjectCommandBashExtension({
    cwd: process.cwd(),
    settings: {
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: join(process.cwd(), ".test-agent"),
    extensionFactories: [userBash, hostBash],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionsOverride: (base) => preferUserBashExtension(base),
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  const bashDefinitions = extensions.extensions
    .map((extension) => extension.tools.get("bash")?.definition)
    .filter(Boolean);

  assert.equal(bashDefinitions.length, 1);
  assert.equal(bashDefinitions[0].description, "user override");
  assert.deepEqual(extensions.errors, []);
});
