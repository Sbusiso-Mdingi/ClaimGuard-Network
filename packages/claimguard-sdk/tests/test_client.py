import json
from unittest.mock import patch, MagicMock

from claimguard_sdk.client import ClaimGuardClient

def test_sanitize_date_of_birth():
    client = ClaimGuardClient("http://api", "key", "secret")
    assert client._sanitize_date_of_birth("1990-05-15") == "1990-01-01"
    assert client._sanitize_date_of_birth("1985-12-31") == "1985-01-01"
    assert client._sanitize_date_of_birth("invalid") is None
    assert client._sanitize_date_of_birth("") == ""

def test_sanitize_coordinate():
    client = ClaimGuardClient("http://api", "key", "secret")
    assert client._sanitize_coordinate(12.3456) == 12.3
    assert client._sanitize_coordinate(-90.18) == -90.2
    assert client._sanitize_coordinate("invalid") is None

def test_submit_batch_tokenizes_pii():
    client = ClaimGuardClient("http://api", "api-key", "test-secret")
    
    members = [{
        "member_id": "mem-123",
        "first_name": "John",
        "last_name": "Doe",
        "identity_number": "9005151234081",
        "banking_detail": "1234567890",
        "date_of_birth": "1990-05-15",
        "home_lat": -26.2041,
        "home_lon": 28.0473
    }]
    
    providers = [{
        "provider_id": "prov-456",
        "practice_number": "PR-999",
        "practice_name": "Dr. Smith Clinic",
        "banking_detail": "0987654321",
        "practice_lat": -33.9249,
        "practice_lon": 18.4241
    }]
    
    claims = [{
        "claim_id": "claim-789",
        "member_id": "mem-123",
        "provider_id": "prov-456",
        "amount": 500.0
    }]
    
    schemes = [{"scheme_id": "sch-1", "scheme_name": "Test Scheme"}]

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_response = MagicMock()
        mock_response.read.return_value = b'{"status": "ok"}'
        mock_urlopen.return_value.__enter__.return_value = mock_response
        
        result = client.submit_batch(claims, members, providers, schemes)
        
        assert result == {"status": "ok"}
        
        # Verify the payload that was sent
        req = mock_urlopen.call_args[0][0]
        payload = json.loads(req.data.decode("utf-8"))
        
        sent_member = payload["members"][0]
        # PII should be tokenized
        assert sent_member["first_name"] != "John"
        assert sent_member["last_name"] != "Doe"
        assert sent_member["identity_number"] != "9005151234081"
        assert sent_member["member_id"] != "mem-123"
        # DOB minimized
        assert sent_member["date_of_birth"] == "1990-01-01"
        # Coordinates rounded
        assert sent_member["home_lat"] == -26.2
        assert sent_member["home_lon"] == 28.0
        
        sent_provider = payload["providers"][0]
        assert sent_provider["practice_number"] != "PR-999"
        assert sent_provider["practice_name"] != "Dr. Smith Clinic"
        assert sent_provider["provider_id"] != "prov-456"
        assert sent_provider["practice_lat"] == -33.9
        
        sent_claim = payload["claims"][0]
        assert sent_claim["claim_id"] != "claim-789"
        # The member_id in the claim must match the tokenized member_id in the member record
        assert sent_claim["member_id"] == sent_member["member_id"]
        assert sent_claim["provider_id"] == sent_provider["provider_id"]
