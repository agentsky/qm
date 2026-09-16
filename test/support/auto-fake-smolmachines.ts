import { beforeEach } from "node:test";
import { installGlobalFakeSmolmachines } from "./fake-smolmachines.ts";

export const fakeSmolmachines = installGlobalFakeSmolmachines();
beforeEach(() => fakeSmolmachines.reset());
