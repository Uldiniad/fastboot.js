import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
    input: "src/index.ts",
    output: [
        {
            file: "dist/fastboot.cjs",
            format: "cjs",
            sourcemap: true,
        },
        {
            file: "dist/fastboot.mjs",
            format: "es",
            sourcemap: true,
        },
    ],
    plugins: [nodeResolve(), typescript()],
};
