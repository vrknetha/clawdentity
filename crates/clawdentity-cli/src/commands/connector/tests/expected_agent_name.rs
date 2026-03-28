use crate::commands::connector::runtime_config::validate_expected_agent_name;

#[test]
fn expected_agent_name_validation_allows_matching_agent() {
    let result = validate_expected_agent_name("alpha-local", Some("alpha-local"));
    assert!(result.is_ok());
}

#[test]
fn expected_agent_name_validation_rejects_mismatched_agent() {
    let error = validate_expected_agent_name("beta-local", Some("alpha-local"))
        .expect_err("mismatched expected agent name should fail");
    assert!(
        error
            .to_string()
            .contains("this environment expects `alpha-local`")
    );
}

#[test]
fn expected_agent_name_validation_allows_unset_expected_name() {
    let result = validate_expected_agent_name("alpha-local", None);
    assert!(result.is_ok());
}

#[test]
fn expected_agent_name_validation_ignores_blank_expected_name() {
    let result = validate_expected_agent_name("alpha-local", Some("   "));
    assert!(result.is_ok());
}
