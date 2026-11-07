@eval @eval-idle-override
Feature: A room can have its own idle timeout

  Background:
    Given a fresh room

  Scenario: the default is reported and the setting is guarded
    When I send a GET request to "/api/rooms/{room}"
    Then the response JSON field "idle_ms" is 15000
    When I send a PUT request to "/api/rooms/{room}/settings" with body:
      """
      { "idle_ms": 2000 }
      """
    Then the last response status is 403
    When I send a PUT request to "/api/rooms/{room}/settings" with the token and body:
      """
      { "idle_ms": 500 }
      """
    Then the last response status is 400
    And the response JSON field "error" is "bad idle_ms"

  Scenario: a lowered idle timeout is persisted and fires the archive sooner
    When I send a PUT request to "/api/rooms/{room}/settings" with the token and body:
      """
      { "idle_ms": 2000 }
      """
    Then the last response status is 200
    And the response JSON field "idle_ms" is 2000
    When I send a GET request to "/api/rooms/{room}"
    Then the response JSON field "idle_ms" is 2000
    When I post a message with msg_id "m-1" and body "then idle"
    And I kill the room
    When I send a GET request to "/api/rooms/{room}"
    Then the response JSON field "idle_ms" is 2000
    And within 10 seconds an idle archive for the room has started
