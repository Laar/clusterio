import { bootstrap } from "./ctl";
export { default as BaseCtlPlugin } from "./src/BaseCtlPlugin";

if (module === require.main) {
	bootstrap();
}
