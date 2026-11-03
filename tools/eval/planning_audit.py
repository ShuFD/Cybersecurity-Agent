"""Read-only adapters: store events retain their original source and timestamp."""
import json, sqlite3, collections
from pathlib import Path

def canonical_event(mode, source, sequence, kind, payload, at):
    role = payload.get('role')
    stage = ('result_submitted' if kind in ('task_result_submitted', 'intent_concluded') else
             'executor_end' if kind in ('executor_end', 'cairn_executor_end') else
             'dispatch' if kind in ('executor_start', 'cairn_executor_start') else
             'submission_staged' if kind == 'planning_submission_staged' else
             'plan_applied' if kind in ('plan_committed', 'reason_proposal_applied') else
             'model_start' if kind.endswith('assistant_message_start') else
             'model_end' if kind.endswith('assistant_message_end') else 'other')
    text = str(payload.get('error') or payload.get('message') or '')
    budget = 'Turn limit reached:' in text or payload.get('failureCode') in ('max_turns','turn_budget_exhausted')
    return {'mode': mode, 'source': str(source), 'sequence': sequence, 'type': kind,
            'at': at, 'stage': stage, 'origin': payload.get('origin'), 'role': role,
            'toolName': payload.get('toolName'), 'toolCallId': payload.get('toolCallId'),
            'requestId': payload.get('requestId'), 'taskId': payload.get('taskId'),
            'stopReason': payload.get('stopReason'), 'budgetCutoff': budget,
            'elapsedMs': payload.get('elapsedMs')}

def read_events(mode, state):
    if mode not in ('progressive','cairn'): raise ValueError('Unknown mode')
    names = ('planning.sqlite',) if mode == 'progressive' else ('host.sqlite','graph.sqlite')
    rows=[]
    for db in Path(state).rglob('*.sqlite'):
        if db.name not in names: continue
        con=sqlite3.connect(db.resolve().as_uri()+'?mode=ro',uri=True)
        tables={r[0] for r in con.execute('select name from sqlite_master where type="table"')}
        table='planning_events' if mode=='progressive' else 'lifecycle'
        column='payload_json' if mode=='progressive' else 'payload'
        if table in tables:
            for seq,kind,payload,at in con.execute(f'select rowid,type,{column},created_at from {table} order by rowid'):
                rows.append(canonical_event(mode,db,seq,kind,json.loads(payload),at))
        con.close()
    return sorted(rows,key=lambda r:(r['at'],r['source'],r['sequence']))

def summarize(rows):
    return {'eventCount':len(rows), 'toolNamesKnown':sum(r['toolName'] is not None for r in rows if r['type'].endswith('tool_execution_start')),
            'toolNamesUnknown':sum(r['toolName'] is None for r in rows if r['type'].endswith('tool_execution_start')),
            'budgetCutoffs':sum(r['budgetCutoff'] for r in rows),
            'stopsByRole':dict(collections.Counter((r['role'] or 'unknown')+':'+r['stopReason'] for r in rows if r['stopReason']))}

if __name__=='__main__':
    import sys
    events=read_events(sys.argv[1],sys.argv[2])
    print(json.dumps({'summary':summarize(events),'events':events}))
