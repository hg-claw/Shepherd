CREATE TABLE subgen_templates (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT    NOT NULL,
  builtin    BOOLEAN NOT NULL DEFAULT false,
  rules_json TEXT    NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subgen_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT    NOT NULL,
  token       TEXT    NOT NULL UNIQUE,
  template_id BIGINT  NOT NULL REFERENCES subgen_templates(id) ON DELETE RESTRICT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subgen_subscription_inbounds (
  subscription_id BIGINT NOT NULL REFERENCES subgen_subscriptions(id) ON DELETE CASCADE,
  source          TEXT   NOT NULL,
  inbound_id      BIGINT NOT NULL,
  PRIMARY KEY (subscription_id, source, inbound_id)
);
