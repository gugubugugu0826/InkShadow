import { spawnSync } from "node:child_process";

const [namespace, image] = process.argv.slice(2);
if (
  namespace === undefined ||
  !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(namespace) ||
  image === undefined ||
  !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(image)
) {
  process.stderr.write("Usage: node upgrade.mjs <namespace> <immutable-image@sha256:digest>\n");
  process.exit(2);
}

run(["-n", namespace, "rollout", "status", "deployment/inkshadow-cloud-api", "--timeout=60s"]);
const previousImage = capture([
  "-n",
  namespace,
  "get",
  "deployment/inkshadow-cloud-api",
  "-o=jsonpath={.spec.template.spec.containers[?(@.name=='api')].image}",
]);
const previousRevision = capture([
  "-n",
  namespace,
  "get",
  "deployment/inkshadow-cloud-api",
  "-o=jsonpath={.metadata.annotations.deployment\\.kubernetes\\.io/revision}",
]);
if (
  !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(previousImage) ||
  !/^[1-9]\d*$/u.test(previousRevision)
) {
  process.stderr.write(
    "Upgrade refused: the current Deployment image/revision is not an immutable rollback point.\n",
  );
  process.exit(1);
}
if (previousImage === image) {
  process.stderr.write("Upgrade refused: the requested image is already deployed.\n");
  process.exit(1);
}

run(["-n", namespace, "set", "image", "deployment/inkshadow-cloud-api", `api=${image}`]);
const rollout = run(
  ["-n", namespace, "rollout", "status", "deployment/inkshadow-cloud-api", "--timeout=10m"],
  false,
);
if (rollout.status !== 0) {
  process.stderr.write(
    `Rollout failed; restoring verified Deployment revision ${previousRevision}.\n`,
  );
  run([
    "-n",
    namespace,
    "rollout",
    "undo",
    "deployment/inkshadow-cloud-api",
    `--to-revision=${previousRevision}`,
  ]);
  run(["-n", namespace, "rollout", "status", "deployment/inkshadow-cloud-api", "--timeout=10m"]);
  const restoredImage = capture([
    "-n",
    namespace,
    "get",
    "deployment/inkshadow-cloud-api",
    "-o=jsonpath={.spec.template.spec.containers[?(@.name=='api')].image}",
  ]);
  if (restoredImage !== previousImage) {
    process.stderr.write(
      "Rollback verification failed: the previous immutable image was not restored.\n",
    );
    process.exit(1);
  }
  process.exit(1);
}
const deployedImage = capture([
  "-n",
  namespace,
  "get",
  "deployment/inkshadow-cloud-api",
  "-o=jsonpath={.spec.template.spec.containers[?(@.name=='api')].image}",
]);
if (deployedImage !== image) {
  process.stderr.write(
    "Upgrade verification failed: the Deployment does not use the requested digest.\n",
  );
  process.exit(1);
}

function run(argumentsList, required = true) {
  const result = spawnSync("kubectl", argumentsList, { stdio: "inherit", shell: false });
  if (result.error !== undefined) {
    process.stderr.write("kubectl could not be executed.\n");
    process.exit(1);
  }
  if (required && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function capture(argumentsList) {
  const result = spawnSync("kubectl", argumentsList, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write("kubectl state inspection failed.\n");
    process.exit(1);
  }
  return result.stdout.trim();
}
