import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useForm } from "@tanstack/react-form";
import { ChevronDown, KeyRound, LoaderCircle, Settings2, Sparkles, X } from "lucide-react";
import { testRoomConfigSchema, type TestRoomConfig } from "#/lib/auction-api";

interface SetupDialogProps {
  config: TestRoomConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: TestRoomConfig) => void;
  onLaunchDemo: () => Promise<boolean>;
  launchingDemo: boolean;
}

export function SetupDialog({
  config,
  open,
  onOpenChange,
  onSave,
  onLaunchDemo,
  launchingDemo,
}: SetupDialogProps) {
  const form = useForm({
    defaultValues: config,
    validators: { onSubmit: testRoomConfigSchema },
    onSubmit: ({ value }) => {
      onSave(testRoomConfigSchema.parse(value));
      onOpenChange(false);
    },
  });

  useEffect(() => {
    if (open) form.reset(config);
  }, [config, form, open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby="setup-description">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>Room setup</Dialog.Title>
              <Dialog.Description id="setup-description">
                Start instantly with a temporary room, or connect your own API credentials.
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close setup">
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="instant-demo-card">
            <div className="instant-demo-copy">
              <span className="instant-demo-icon">
                <Sparkles size={19} />
              </span>
              <div>
                <strong>Instant demo room</strong>
                <p>Creates and starts a private auction with 15-minute credentials.</p>
              </div>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={launchingDemo}
              onClick={async () => {
                if (await onLaunchDemo()) onOpenChange(false);
              }}
            >
              {launchingDemo ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}
              {launchingDemo ? "Starting…" : "Launch instant demo"}
            </button>
          </div>

          <details className="advanced-setup">
            <summary>
              <span>Advanced setup</span>
              <ChevronDown size={16} />
            </summary>
            <form
              className="setup-form"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <div className="form-section">
                <div className="form-section-title">
                  <Settings2 size={17} />
                  Room
                </div>
                <form.Field name="apiBaseUrl">
                  {(field) => (
                    <label className="field-label">
                      API base URL
                      <input
                        type="url"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        spellCheck={false}
                      />
                    </label>
                  )}
                </form.Field>
                <form.Field name="auctionId">
                  {(field) => (
                    <label className="field-label">
                      Auction ID
                      <input
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        pattern="[A-Za-z0-9_-]{1,100}"
                        spellCheck={false}
                      />
                    </label>
                  )}
                </form.Field>
              </div>

              <div className="form-section">
                <div className="form-section-title">
                  <KeyRound size={17} />
                  Short-lived JWTs
                </div>
                {(
                  [
                    ["sellerToken", "Seller token"],
                    ["bidderToken", "Bidder token"],
                    ["viewerToken", "Viewer token"],
                  ] as const
                ).map(([name, label]) => (
                  <form.Field key={name} name={name}>
                    {(field) => (
                      <label className="field-label">
                        {label}
                        <textarea
                          rows={2}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value.trim())}
                          placeholder="eyJhbGciOiJFUzI1NiIs…"
                          spellCheck={false}
                        />
                      </label>
                    )}
                  </form.Field>
                ))}
              </div>

              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
                {([canSubmit, isSubmitting]) => (
                  <button className="primary-button dialog-submit" disabled={!canSubmit}>
                    {isSubmitting ? "Saving…" : "Connect room"}
                  </button>
                )}
              </form.Subscribe>
            </form>
          </details>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
