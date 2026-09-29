import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig((ctx) => {
  switch (ctx.mode) {
    case "staging": {
      return {
        types: {
          generate: false,
        },
      };
    }
    default: {
      return {
        types: {
          generate: false,
        },
      };
    }
  }
});
