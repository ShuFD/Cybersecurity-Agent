import tempfile,sqlite3,json,unittest
from pathlib import Path
from planning_audit import read_events,summarize
class AuditTest(unittest.TestCase):
 def test_modes_keep_sources_unknowns_and_budget(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory)
   for mode,name,table,col in [('progressive','planning.sqlite','planning_events','payload_json'),('cairn','host.sqlite','lifecycle','payload')]:
    con=sqlite3.connect(root/name);con.execute(f'create table {table}(type text,{col} text,created_at integer)')
    con.executemany(f'insert into {table} values(?,?,?)',[('tool_execution_start',json.dumps({'role':'planner','toolName':'planning_read_evidence','requestId':'r'}),1),('executor_end',json.dumps({'error':'[Budget] Turn limit reached: 220/220'}),2),('assistant_message_end',json.dumps({'role':'executor','stopReason':'error','elapsedMs':616400}),3)])
    con.commit();con.close()
    events=read_events(mode,root);self.assertEqual(len(events),3);self.assertEqual(events[0]['requestId'],'r');self.assertEqual(summarize(events)['budgetCutoffs'],1);self.assertEqual(events[2]['elapsedMs'],616400);self.assertTrue(all(Path(e['source']).name==name for e in events))
 def test_unknown_metadata_is_not_invented(self):
  with tempfile.TemporaryDirectory() as directory:
   con=sqlite3.connect(Path(directory)/'planning.sqlite');con.execute('create table planning_events(type text,payload_json text,created_at integer)');con.execute('insert into planning_events values(?,?,?)',('tool_execution_start','{"role":"planner"}',1));con.commit();con.close()
   summary=summarize(read_events('progressive',directory));self.assertEqual(summary['toolNamesKnown'],0);self.assertEqual(summary['toolNamesUnknown'],1)
if __name__=='__main__':unittest.main()
