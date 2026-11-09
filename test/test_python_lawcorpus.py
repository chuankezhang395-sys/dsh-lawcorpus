"""真实题录的端到端回归与边界测试；不依赖Node或外部包。"""
import csv
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / '.agents/skills/law-paper-writing/scripts/lawcorpus.py'
spec = importlib.util.spec_from_file_location('lawcorpus', SCRIPT)
law = importlib.util.module_from_spec(spec)
spec.loader.exec_module(law)


class RealCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / 'work').mkdir(exist_ok=True)
        cls.corpus = law.Corpus(ROOT / 'data')
        cls.original_bytes = {f: f.read_bytes() for f in cls.corpus.files}

    def call(self, *argv):
        return law.run(law.parser().parse_args(['--data-dir', str(ROOT / 'data'), *argv]))

    def test_status_real_counts_and_completeness(self):
        r = self.call('status')
        self.assertEqual(r['total'], 850)
        self.assertEqual(r['types'], {'article': 847, 'editorial': 3})
        self.assertEqual(r['by_journal'], {'中国法学': 253, '比较法研究': 220, '法学研究': 197, '中外法学': 180})
        for f in ['abstract', 'keywords', 'outline']:
            self.assertEqual(r['completeness'][f], {'present': 847, 'denominator': 847})
        self.assertIn('7e581ab4794a', [x['article']['id'] for x in r['suspect_short_titles']])

    def test_child_support_has_no_direct_hit(self):
        for query in ['离婚后未成年子女抚养费', '抚养费', '抚养']:
            r = self.call('search', '--query', query, '--mode', 'phrase')
            self.assertEqual(r['matched_total'], 0, query)
        for query, expected in [('离婚', 4), ('子女', 4), ('未成年', 11)]:
            self.assertEqual(self.call('search', '--query', query, '--mode', 'phrase')['matched_total'], expected)

    def test_ranked_returns_traceable_partial_hits(self):
        r = self.call('search', '--query', '离婚后未成年子女抚养费', '--limit', '5')
        self.assertGreater(r['matched_total'], 0)
        self.assertEqual(len(r['results']), 5)
        for row in r['results']:
            self.assertLess(row['coverage'], 1)
            self.assertEqual(row['exact_phrase_fields'], [])
            actual = json.loads(Path(row['location']['file']).read_text().splitlines()[row['location']['line'] - 1])
            self.assertEqual(row['article'], actual)

    def test_frames_preserve_real_outline_and_original_sentences(self):
        r = self.call('frame', '--query', '亲属扶养', '--mode', 'phrase')
        row = r['results'][0]
        a = row['article']
        self.assertEqual(a['id'], 'e966d02dc1e7')
        self.assertEqual(a['title'], '亲属扶养的理论构造及规范展开')
        self.assertEqual(a['authors'], ['夏江皓'])
        self.assertEqual(row['frame']['outline_original'], a['outline'])
        for value in row['frame']['abstract_slots_original_rule_based'].values():
            self.assertTrue(value is None or value in a['abstract'])

    def test_filters_and_profile_use_full_sample(self):
        r = self.call('profile', '--journal', '《法学研究》', '--year-from', '2025', '--year-to', '2025', '--limit', '1')
        self.assertEqual(r['count'], 70)
        self.assertEqual(sum(r['genres_rule_based'].values()), 70)
        self.assertEqual(r['by_year'], {2025: 70})
        self.assertEqual(self.call('search', '--query', '离婚', '--journal', '不存在的刊')['matched_total'], 0)
        all_rows = self.call('search', '--query', '离婚 子女', '--mode', 'all', '--limit', '100')['results']
        self.assertGreater(len(all_rows), 0)
        for row in all_rows:
            text = '\n'.join(law.field_text(row['article'], f) for f in law.FIELDS)
            self.assertTrue('离婚' in text and '子女' in text)

    def test_match_identical_record_and_topic(self):
        a = next(a for a in self.corpus.articles if a['id'] == 'e966d02dc1e7')
        r = self.call('match', '--title', a['title'], '--abstract', a['abstract'], '--keywords', '；'.join(a['keywords']))
        top = r['results'][0]
        self.assertEqual(top['article']['id'], a['id'])
        self.assertEqual(top['comparison']['query_token_coverage_percent'], 100)
        self.assertEqual(top['comparison']['abstract_chars_difference'], 0)
        topic = self.call('match', '--title', '离婚后未成年子女抚养费', '--keywords', '离婚；子女；抚养费')
        self.assertTrue(topic['results'])
        self.assertLess(topic['results'][0]['comparison']['query_token_coverage_percent'], 100)

    def test_exports_roundtrip_and_no_overwrite_or_escape(self):
        a = next(a for a in self.corpus.articles if a['id'] == 'e966d02dc1e7')
        with tempfile.TemporaryDirectory(dir=ROOT / 'work') as directory, patch('pathlib.Path.cwd', return_value=Path(directory)):
            for fmt, suffix in [('jsonl', 'jsonl'), ('csv', 'csv'), ('markdown', 'md')]:
                dest = Path(directory) / 'output' / ('result.' + suffix)
                self.call('export', '--query', '亲属扶养', '--mode', 'phrase', '--format', fmt, '--output', str(dest))
                with self.assertRaises(FileExistsError):
                    law.export_records(self.corpus, [a], dest, fmt)
                if fmt == 'jsonl':
                    self.assertEqual([json.loads(l) for l in dest.read_text().splitlines()], [a])
                elif fmt == 'csv':
                    with dest.open(encoding='utf-8-sig', newline='') as stream:
                        row = list(csv.DictReader(stream))[0]
                    self.assertEqual(row['title'], a['title'])
                    self.assertEqual(json.loads(row['outline']), a['outline'])
                    self.assertEqual(row['abstract'], a['abstract'])
                else:
                    content = dest.read_text()
                    self.assertIn(a['abstract'], content)
                    self.assertTrue(all(x in content for x in a['outline']))
                law.export_records(self.corpus, [a], dest, fmt, overwrite=True)
            with self.assertRaises(ValueError):
                law.export_records(self.corpus, [a], Path(directory) / 'escape.jsonl', 'jsonl')
            (Path(directory) / 'output' / 'link').symlink_to(ROOT / 'data', target_is_directory=True)
            with self.assertRaises(ValueError):
                law.export_records(self.corpus, [a], Path(directory) / 'output/link/escape.jsonl', 'jsonl')
            empty = Path(directory) / 'output/empty.jsonl'
            result = self.call('export', '--query', '抚养费', '--mode', 'phrase', '--format', 'jsonl', '--output', str(empty))
            self.assertEqual(result['count'], 0)
            self.assertEqual(empty.read_text(), '')
        self.assertTrue(all(f.read_bytes() == content for f, content in self.original_bytes.items()))

    def test_cli_default_path_independent_of_cwd_and_errors(self):
        env = dict(os.environ)
        env.pop('LAWCORPUS_DIR', None)
        result = subprocess.run([sys.executable, str(SCRIPT), 'status'], cwd='/tmp', env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['total'], 850)
        for argv in [('search',), ('search', '--query', '法'), ('match',),
                     ('status', '--year-from', '2026', '--year-to', '2024'),
                     ('search', '--query', '离婚', '--min-coverage', '2')]:
            result = subprocess.run([sys.executable, str(SCRIPT), *argv], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 2, argv)
            self.assertIn('error', json.loads(result.stderr))

    def test_bad_data_fails_with_file_and_line(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'work') as directory:
            f = Path(directory) / 'bad.jsonl'
            f.write_text('{broken}\n')
            with self.assertRaisesRegex(ValueError, r'bad.jsonl:1:'):
                law.Corpus(directory)
            a = self.corpus.articles[0]
            f.write_text((json.dumps(a) + '\n') * 2)
            with self.assertRaisesRegex(ValueError, '重复 ID'):
                law.Corpus(directory)


if __name__ == '__main__':
    unittest.main()
