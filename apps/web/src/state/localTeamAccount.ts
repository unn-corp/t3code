import { createLocalTeamAccountCommands } from "@t3tools/client-runtime/state/localTeamAccount";
import { connectionAtomRuntime } from "../connection/runtime";

export const localTeamAccountCommand = createLocalTeamAccountCommands(connectionAtomRuntime);
