pub(super) fn install_check_label(id: &str) -> &'static str {
    match id {
        "state.transform" => "Relay transform",
        "state.skillArtifacts" => "OpenClaw skill artifacts",
        "state.hookToken" => "OpenClaw hook token",
        "state.hookMapping" => "OpenClaw hook mapping",
        "state.hookSessionRouting" => "OpenClaw hook session routing",
        "state.gatewayAuth" => "OpenClaw gateway auth",
        _ => "OpenClaw install state",
    }
}

pub(super) fn install_check_remediation(id: &str) -> Option<&'static str> {
    match id {
        "state.gatewayAuth" => Some(
            "Fix OpenClaw auth first with `openclaw onboard` or `openclaw doctor --fix`, then rerun `clawdentity provider setup --for openclaw --agent-name <agentName>`.",
        ),
        "state.transform"
        | "state.skillArtifacts"
        | "state.hookToken"
        | "state.hookMapping"
        | "state.hookSessionRouting" => Some(
            "Run `clawdentity provider setup --for openclaw --agent-name <agentName>` after OpenClaw itself is healthy.",
        ),
        _ => None,
    }
}
