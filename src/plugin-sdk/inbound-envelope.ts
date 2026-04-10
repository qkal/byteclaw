interface RouteLike {
  agentId: string;
  sessionKey: string;
}

interface RoutePeerLike {
  kind: string;
  id: string | number;
}

interface InboundEnvelopeFormatParams<TEnvelope> {
  channel: string;
  from: string;
  timestamp?: number;
  previousTimestamp?: number;
  envelope: TEnvelope;
  body: string;
}

interface InboundRouteResolveParams<TConfig, TPeer extends RoutePeerLike> {
  cfg: TConfig;
  channel: string;
  accountId: string;
  peer: TPeer;
}

/** Create an envelope formatter bound to one resolved route and session store. */
export function createInboundEnvelopeBuilder<TConfig, TEnvelope>(params: {
  cfg: TConfig;
  route: RouteLike;
  sessionStore?: string;
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
  readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
  formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
}) {
  const storePath = params.resolveStorePath(params.sessionStore, {
    agentId: params.route.agentId,
  });
  const envelopeOptions = params.resolveEnvelopeFormatOptions(params.cfg);
  return (input: { channel: string; from: string; body: string; timestamp?: number }) => {
    const previousTimestamp = params.readSessionUpdatedAt({
      sessionKey: params.route.sessionKey,
      storePath,
    });
    const body = params.formatAgentEnvelope({
      body: input.body,
      channel: input.channel,
      envelope: envelopeOptions,
      from: input.from,
      previousTimestamp,
      timestamp: input.timestamp,
    });
    return { body, storePath };
  };
}

/** Resolve a route first, then return both the route and a formatter for future inbound messages. */
export function resolveInboundRouteEnvelopeBuilder<
  TConfig,
  TEnvelope,
  TRoute extends RouteLike,
  TPeer extends RoutePeerLike,
>(params: {
  cfg: TConfig;
  channel: string;
  accountId: string;
  peer: TPeer;
  resolveAgentRoute: (params: InboundRouteResolveParams<TConfig, TPeer>) => TRoute;
  sessionStore?: string;
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
  readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
  formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
}): {
  route: TRoute;
  buildEnvelope: ReturnType<typeof createInboundEnvelopeBuilder<TConfig, TEnvelope>>;
} {
  const route = params.resolveAgentRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: params.channel,
    peer: params.peer,
  });
  const buildEnvelope = createInboundEnvelopeBuilder({
    cfg: params.cfg,
    formatAgentEnvelope: params.formatAgentEnvelope,
    readSessionUpdatedAt: params.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: params.resolveEnvelopeFormatOptions,
    resolveStorePath: params.resolveStorePath,
    route,
    sessionStore: params.sessionStore,
  });
  return { buildEnvelope, route };
}

interface InboundRouteEnvelopeRuntime<
  TConfig,
  TEnvelope,
  TRoute extends RouteLike,
  TPeer extends RoutePeerLike,
> {
  routing: {
    resolveAgentRoute: (params: InboundRouteResolveParams<TConfig, TPeer>) => TRoute;
  };
  session: {
    resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
    readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  };
  reply: {
    resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
    formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
  };
}

/** Runtime-driven variant of inbound envelope resolution for plugins that already expose grouped helpers. */
export function resolveInboundRouteEnvelopeBuilderWithRuntime<
  TConfig,
  TEnvelope,
  TRoute extends RouteLike,
  TPeer extends RoutePeerLike,
>(params: {
  cfg: TConfig;
  channel: string;
  accountId: string;
  peer: TPeer;
  runtime: InboundRouteEnvelopeRuntime<TConfig, TEnvelope, TRoute, TPeer>;
  sessionStore?: string;
}): {
  route: TRoute;
  buildEnvelope: ReturnType<typeof createInboundEnvelopeBuilder<TConfig, TEnvelope>>;
} {
  return resolveInboundRouteEnvelopeBuilder({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: params.channel,
    formatAgentEnvelope: params.runtime.reply.formatAgentEnvelope,
    peer: params.peer,
    readSessionUpdatedAt: params.runtime.session.readSessionUpdatedAt,
    resolveAgentRoute: (routeParams) => params.runtime.routing.resolveAgentRoute(routeParams),
    resolveEnvelopeFormatOptions: params.runtime.reply.resolveEnvelopeFormatOptions,
    resolveStorePath: params.runtime.session.resolveStorePath,
    sessionStore: params.sessionStore,
  });
}
