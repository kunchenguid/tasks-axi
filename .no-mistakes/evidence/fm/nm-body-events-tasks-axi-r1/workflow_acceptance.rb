#!/usr/bin/env ruby

require "open3"
require "yaml"

workflow_path = ".github/workflows/no-mistakes-required.yml"
base = "0e2cf5904cc227bb66fed66bddac23da6ee449db"
target = "460bdb68cbf7e0cb5692bb2f267676e53ed6c9f8"
source = File.read(workflow_path)
workflow = YAML.load_file(workflow_path)

def assert(label, condition)
  raise "FAIL: #{label}" unless condition

  puts "PASS: #{label}"
end

puts "tasks-axi no-mistakes workflow acceptance"
puts

changed_files, changed_status = Open3.capture2(
  "git", "diff", "--name-only", "#{base}..#{target}"
)
assert("committed scope is only the required workflow", changed_status.success? &&
  changed_files.lines.map(&:strip) == [workflow_path])

diff, diff_status = Open3.capture2(
  "git", "diff", "#{base}..#{target}", "--", workflow_path
)
assert("the workflow change contains exactly two hunks",
  diff_status.success? && diff.lines.count { |line| line.start_with?("@@") } == 2)

expected_run_name = 'run-name: "PR #${{ github.event.pull_request.number }} body compliance - ${{ github.event.action }} - event ${{ github.run_number }} (run ${{ github.run_id }})"'
expected_group = "group: no-mistakes-required-${{ github.event.pull_request.number }}-${{ (github.event.action == 'opened' || github.event.action == 'edited') && github.run_id || 'head-change' }}"

assert("YAML syntax parses", workflow.is_a?(Hash))
assert("canonical run-name is exact", source.include?(expected_run_name))
assert("opened/edited use run_id while head changes coalesce", source.include?(expected_group))
assert("cancel-in-progress remains true", source.match?(/^\s+cancel-in-progress: true$/))

assert("pull_request trigger and event set are preserved",
  source.include?("pull_request:\n    types: [opened, edited, synchronize, reopened]"))
assert("main branch filter is preserved", source.include?("branches:\n      - main"))
assert("permissions remain contents read-only",
  source.include?("permissions:\n  contents: read\n") &&
  !source.match?(/pull-requests:\s*write/) &&
  !source.match?(/contents:\s*write/))
assert("workflow does not use pull_request_target", !source.include?("pull_request_target"))
assert("workflow does not reference secrets", !source.match?(/\bsecrets\./))
assert("workflow does not check out or execute fork code",
  !source.include?("actions/checkout") && !source.match?(/\bgithub\.event\.pull_request\.head\./))
assert("stable check name is preserved", source.include?("name: PR must be raised via no-mistakes"))

%w[github-actions[bot] dependabot[bot] release-please[bot]].each do |bot|
  assert("#{bot} exemption is preserved", source.include?("'#{bot}'"))
end

marker = "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)"
assert("signature marker is preserved exactly", source.include?("marker='#{marker}'"))

def identity(pr:, action:, run_number:, run_id:)
  suffix = %w[opened edited].include?(action) ? run_id : "head-change"
  group = "no-mistakes-required-#{pr}-#{suffix}"
  name = "PR ##{pr} body compliance - #{action} - event #{run_number} (run #{run_id})"
  [group, name]
end

events = [
  ["unsigned opened", 42, "opened", 301, 9001],
  ["signed edited", 42, "edited", 302, 9002],
  ["signed same-head replay", 42, "edited", 303, 9003],
  ["synchronize", 42, "synchronize", 304, 9004],
  ["reopened", 42, "reopened", 305, 9005]
]

puts
puts "Resolved run identities"
events.each do |label, pr, action, run_number, run_id|
  group, name = identity(pr: pr, action: action, run_number: run_number, run_id: run_id)
  puts "#{label}:"
  puts "  group: #{group}"
  puts "  run-name: #{name}"
end

opened_group = identity(pr: 42, action: "opened", run_number: 301, run_id: 9001).first
edit_group = identity(pr: 42, action: "edited", run_number: 302, run_id: 9002).first
replay_group = identity(pr: 42, action: "edited", run_number: 303, run_id: 9003).first
sync_group = identity(pr: 42, action: "synchronize", run_number: 304, run_id: 9004).first
reopen_group = identity(pr: 42, action: "reopened", run_number: 305, run_id: 9005).first

assert("opened, edited, and same-head replay cannot collapse",
  [opened_group, edit_group, replay_group].uniq.length == 3)
assert("synchronize and reopened retain head-change coalescing", sync_group == reopen_group)

run_script = workflow.fetch("jobs").fetch("check").fetch("steps").first.fetch("run")

def replay(run_script, label, body)
  stdout, stderr, status = Open3.capture3(
    {
      "PR_BODY" => body,
      "PR_AUTHOR" => "contributor",
      "PR_NUMBER" => "42"
    },
    "bash", "-c", run_script
  )
  puts
  puts "#{label}: exit #{status.exitstatus}"
  print stdout
  print stderr
  status.exitstatus
end

unsigned = replay(run_script, "unsigned opened body", "A normal pull request body.")
signed = replay(run_script, "signed edited body", "## Pipeline\n\n#{marker}")
same_head = replay(
  run_script,
  "signed same-head edited replay",
  "Updated context, unchanged head.\n\n## Pipeline\n\n#{marker}"
)

assert("unsigned body is rejected", unsigned == 1)
assert("signed edit is accepted", signed == 0)
assert("signed same-head replay is accepted", same_head == 0)

puts
puts "RESULT: workflow acceptance passed"
