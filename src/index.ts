import { installTools, defaultEnvSource } from "./tools/index.ts";
import { installSessionHooks } from "./hooks/events.ts";

export default function install(pi: import("./hooks/events.ts").Pi): void {
  const envSource = defaultEnvSource(pi);
  installSessionHooks(pi, envSource);
  installTools(pi, envSource);
}