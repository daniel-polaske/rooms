@eval @eval-history-search
Feature: History can be filtered by a substring of the body

  Background:
    Given a fresh room
    When I post a message with msg_id "m-1" and body "alpha one"
    And I post a message with msg_id "m-2" and body "beta two"
    And I post a message with msg_id "m-3" and body "ALPHA three"

  Scenario: the filter is a case-insensitive substring match, in seq order
    When I send a GET request to "/api/rooms/{room}/messages?q=alpha"
    Then the last response status is 200
    And the response JSON array has 2 items
    And the response JSON field "0.msg_id" is "m-1"
    And the response JSON field "1.msg_id" is "m-3"

  Scenario: no match is an empty list, not an error
    When I send a GET request to "/api/rooms/{room}/messages?q=zzz"
    Then the last response status is 200
    And the response JSON array has 0 items

  Scenario: the filter composes with paging
    When I send a GET request to "/api/rooms/{room}/messages?q=alpha&after={first_seq}"
    Then the response JSON array has 1 item
    And the response JSON field "0.msg_id" is "m-3"

  Scenario: an absent filter is the unchanged history
    When I send a GET request to "/api/rooms/{room}/messages"
    Then the response JSON array has 3 items

  Scenario: an oversized filter is rejected
    When I send a GET request to "/api/rooms/{room}/messages?q=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the last response status is 400
    And the response JSON field "error" is "q too long"
    And the response JSON field "max" is 200
