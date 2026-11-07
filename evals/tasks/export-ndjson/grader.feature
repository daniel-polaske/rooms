@eval @eval-export-ndjson
Feature: An archive can be read as newline-delimited JSON

  Background:
    Given a fresh room
    When I post 3 messages
    And I start an archive with the token
    Then the last response status is 202
    And within 60 seconds the archive status is "complete"

  Scenario: ndjson is one message per line, in order
    When I send a GET request to "/api/archives/{instance}/body?format=ndjson"
    Then the last response status is 200
    And the response header "content-type" contains "application/x-ndjson"
    And the response body has 3 lines
    And every line of the response body is JSON with a field "msg_id"
    And every line of the response body is JSON with a field "seq"

  Scenario: json is unchanged and other formats are refused
    When I send a GET request to "/api/archives/{instance}/body?format=json"
    Then the last response status is 200
    And the response JSON field "count" is 3
    And the response JSON array "messages" has 3 items
    When I send a GET request to "/api/archives/{instance}/body?format=xml"
    Then the last response status is 400
    And the response JSON field "error" is "bad format"
