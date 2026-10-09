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
        dev: {
          // Portless assigns PORT; Wrangler does not read it on its own.
          port: Number(process.env.PORT) || undefined,
        },
        types: {
          generate: false,
        },
      };
    }
  }
});
